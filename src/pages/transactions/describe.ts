/**
 * Plain-language descriptions of edits, for saying what an undo or redo
 * did: "category of Corner Market: Groceries → Coffee". Values read as the
 * cells show them.
 */
import { hasPatch, type TransactionRow } from "../../db/queries/transactions.ts";
import { columns, type EditContext } from "./columns.ts";
import { findName } from "./fields.ts";
import type { MarkKind } from "./marks.ts";
import type { TransactionChange } from "./TransactionsTable.tsx";

/** Longer counterparties make the description "of a transaction". */
export const MAX_NAME_LENGTH = 30;
/** Longer values are cut off with an ellipsis. */
export const MAX_VALUE_LENGTH = 40;

/** A row added from the action bar: "Undid adding a transaction". */
export const ADD_DESCRIPTION = "adding a transaction";

type Field = TransactionChange["field"];

const columnOf = (field: Field) => columns.find((column) => column.meta!.editor?.field === field)!;

/** The field's name in a sentence: "category". */
const fieldName = (field: Field) => String(columnOf(field).header).toLowerCase();

function shorten(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** What `row`'s cell for `field` shows, "none" if it's empty. */
function shown(row: TransactionRow, field: Field) {
  const text = columnOf(field).meta!.display(row);
  return text === "" ? "none" : shorten(text, MAX_VALUE_LENGTH);
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** A transaction in a sentence: its counterparty, or "a transaction" if that's long. */
function nameOf({ counterparty }: TransactionRow) {
  return counterparty.length > MAX_NAME_LENGTH ? "a transaction" : counterparty;
}

/** Whether `change` stores what emptying its cell would, like 0 for an amount. */
function clears(
  { rowIndex, field, patch }: TransactionChange,
  rows: readonly TransactionRow[],
  context: EditContext,
) {
  const row = rows[rowIndex]!;
  const cleared = columnOf(field).meta!.editor!.parse("", row, { ...context, create: false });
  return cleared.ok && hasPatch({ ...row, ...patch }, cleared.value);
}

/**
 * Describes making `changes` to `rows` (as they are before them).
 * `context` has the categories there are, so one that's new says so.
 */
export function describeEdit(
  changes: readonly TransactionChange[],
  rows: readonly TransactionRow[],
  context: EditContext,
) {
  const { categories } = context;
  const [change] = changes;
  if (changes.length === 1 && change) {
    const before = rows[change.rowIndex]!;
    const after = { ...before, ...change.patch };
    const name = nameOf(before);
    const field = fieldName(change.field);
    if (change.field === "remarks") return `a change to the ${field} of ${name}`;
    const from = shown(before, change.field);
    const to = shown(after, change.field);
    // Where the amount reads the same, like an empty one (0), only the
    // currency shows the change.
    if (change.field === "amount" && from === to && before.currency !== after.currency)
      return `currency of ${name}: ${before.currency} → ${after.currency}`;
    const isNew =
      change.field === "category" &&
      after.category !== null &&
      findName(categories, after.category) === undefined;
    return `${field} of ${name}: ${from} → ${to}${isNew ? " (new)" : ""}`;
  }

  const cells = plural(changes.length, "cell");
  const transactions = plural(new Set(changes.map(({ rowIndex }) => rowIndex)).size, "transaction");
  const cleared = changes.every((change) => clears(change, rows, context));
  return `${cleared ? "clearing" : "changes to"} ${cells} in ${transactions}`;
}

/** Describes deleting `rows`: "deleting Corner Market", or "deleting 3 transactions". */
export function describeDelete(rows: readonly TransactionRow[]) {
  const [row] = rows;
  return rows.length === 1 && row
    ? `deleting ${nameOf(row)}`
    : `deleting ${plural(rows.length, "transaction")}`;
}

/**
 * Describes marking `rows` as `kind`: "marking Corner Market as a
 * duplicate", or "marking 3 transactions as duplicates".
 */
export function describeMark(kind: MarkKind, rows: readonly TransactionRow[]) {
  const [row] = rows;
  return rows.length === 1 && row
    ? `marking ${nameOf(row)} as a ${kind}`
    : `marking ${plural(rows.length, "transaction")} as ${kind}s`;
}
