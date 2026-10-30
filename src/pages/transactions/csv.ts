/**
 * The transactions as CSV (RFC 4180), for other programs: a header row, then
 * a row for each transaction, each ending in CRLF. Fields with a comma, a
 * quote or a line break are quoted, quotes doubled.
 */

import type { ListedTransaction } from "../../db/queries/transactions.ts";
import { decimalString } from "../../lib/money.ts";

const HEADER = [
  "Date",
  "Time",
  "Account",
  "Counterparty",
  "Category",
  "Currency",
  "Amount",
  "Remarks",
];

/** `field` as CSV: quoted, if it has to be. */
function csvField(field: string) {
  return /[",\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
}

const csvRow = (fields: readonly string[]) => `${fields.map(csvField).join(",")}\r\n`;

/**
 * The time of a timestamp (seconds since the Unix epoch) in `timeZone`, as
 * `HH:MM:SS` on a 24-hour clock.
 */
function timeFormatter(timeZone: string | undefined) {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return (timestamp: number) => {
    const parts = format.formatToParts(timestamp * 1000);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)!.value;
    return `${part("hour")}:${part("minute")}:${part("second")}`;
  };
}

/**
 * `transactions` as CSV, in their order: their date, their time in
 * `timeZone` (the browser's, by default) or nothing without one, and their
 * amount exactly as stored, signed (`-46.20`), with its currency's code
 * before it in a column of its own. Remarks are the transaction's own,
 * without what's noted about them (see marks.ts).
 */
export function transactionsCsv(
  transactions: readonly ListedTransaction[],
  timeZone?: string,
): string {
  const timeOf = timeFormatter(timeZone);
  let csv = csvRow(HEADER);
  for (const transaction of transactions)
    csv += csvRow([
      transaction.naive_date,
      transaction.timestamp === null ? "" : timeOf(transaction.timestamp),
      transaction.account_name,
      transaction.counterparty,
      transaction.category ?? "",
      transaction.currency,
      decimalString(transaction),
      transaction.remarks ?? "",
    ]);
  return csv;
}
