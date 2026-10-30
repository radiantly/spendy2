import { describe, expect, it } from "vitest";
import type { ListedTransaction } from "../../db/queries/transactions.ts";
import { transactionsCsv } from "./csv.ts";

function transaction(overrides: Partial<ListedTransaction> = {}): ListedTransaction {
  return {
    id: "t1",
    timestamp: null,
    sort_key: 1,
    naive_date: "2026-10-10",
    account_name: "Checking",
    counterparty: "Corner Market",
    category: "Groceries",
    amount: -4620,
    decimals: 2,
    currency: "USD",
    remarks: null,
    transfer_account: null,
    duplicate_of: null,
    conversions: {},
    ...overrides,
  };
}

const HEADER = "Date,Time,Account,Counterparty,Category,Currency,Amount,Remarks";
/** The rows after the header, as lines. */
const rows = (transactions: ListedTransaction[], timeZone = "UTC") =>
  transactionsCsv(transactions, timeZone).split("\r\n").slice(1, -1);

describe("transactionsCsv", () => {
  it("starts with the header, and ends each row with CRLF", () => {
    expect(transactionsCsv([transaction()])).toBe(
      `${HEADER}\r\n2026-10-10,,Checking,Corner Market,Groceries,USD,-46.20,\r\n`,
    );
  });

  it("is just the header without transactions", () => {
    expect(transactionsCsv([])).toBe(`${HEADER}\r\n`);
  });

  it("keeps the transactions' order", () => {
    const first = transaction({ counterparty: "Zest" });
    const second = transaction({ counterparty: "Apple" });

    expect(rows([first, second]).map((row) => row.split(",")[3])).toEqual(["Zest", "Apple"]);
  });

  it("writes the time in the time zone, on a 24-hour clock", () => {
    const timestamp = Date.parse("2026-10-10T18:05:09Z") / 1000;

    expect(rows([transaction({ timestamp })])[0]).toContain(",18:05:09,");
    expect(rows([transaction({ timestamp })], "Asia/Singapore")[0]).toContain(",02:05:09,");
  });

  it("writes midnight as 00:00:00", () => {
    const timestamp = Date.parse("2026-10-10T00:00:00Z") / 1000;

    expect(rows([transaction({ timestamp })])[0]).toContain(",00:00:00,");
  });

  it("writes the time in the browser's time zone by default", () => {
    const timestamp = Date.parse("2026-10-10T18:05:09Z") / 1000;
    const local = new Date(timestamp * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const time = [local.getHours(), local.getMinutes(), local.getSeconds()].map(pad).join(":");

    expect(transactionsCsv([transaction({ timestamp })])).toContain(`,${time},`);
  });

  it("writes the amount signed, exactly as stored, without grouping", () => {
    const amounts = [
      transaction({ amount: 123456789, decimals: 2 }),
      transaction({ amount: -5, decimals: 2 }),
      transaction({ amount: 0, decimals: 2 }),
      transaction({ amount: -500, decimals: 0, currency: "JPY" }),
      transaction({ amount: 12345, decimals: 3, currency: "KWD" }),
    ];

    expect(rows(amounts).map((row) => row.split(",").slice(5, 7).join(" "))).toEqual([
      "USD 1234567.89",
      "USD -0.05",
      "USD 0.00",
      "JPY -500",
      "KWD 12.345",
    ]);
  });

  it("leaves a missing category and remarks empty", () => {
    expect(rows([transaction({ category: null, remarks: null })])[0]).toBe(
      "2026-10-10,,Checking,Corner Market,,USD,-46.20,",
    );
  });

  it("writes the remarks without what's noted about the transaction", () => {
    const marked = transaction({ remarks: "Refund", duplicate_of: "t0", transfer_account: "Card" });

    expect(rows([marked])[0]).toMatch(/,Refund$/);
  });

  it("quotes a field with a comma, a quote or a line break, doubling its quotes", () => {
    const csv = transactionsCsv([
      transaction({ counterparty: "Smith, Jones & Co", remarks: 'Said "thanks"\nand left' }),
    ]);

    expect(csv).toContain(`,"Smith, Jones & Co",`);
    expect(csv).toContain(`,"Said ""thanks""\nand left"\r\n`);
  });

  it("leaves other fields unquoted, spaces and all", () => {
    expect(rows([transaction({ counterparty: " Café Lumen " })])[0]).toContain(", Café Lumen ,");
  });
});
