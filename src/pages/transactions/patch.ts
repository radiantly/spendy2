import type { TransactionPatch, TransactionRow } from "../../db/queries/transactions.ts";

/** The patch's columns, each with its value. */
export function patchEntries(patch: TransactionPatch) {
  return Object.entries(patch) as [keyof TransactionRow, TransactionRow[keyof TransactionRow]][];
}

/** Whether `row` already has every value in `patch`. */
export function hasPatch(row: TransactionRow, patch: TransactionPatch) {
  return patchEntries(patch).every(([column, value]) => row[column] === value);
}
