import type { TransactionPatch, TransactionRow } from "../../db/queries/transactions.ts";

/** The patch's columns, each with its value. */
export function patchEntries(patch: TransactionPatch) {
  return Object.entries(patch) as [keyof TransactionRow, TransactionRow[keyof TransactionRow]][];
}

/** Whether `row` already has every value in `patch`. */
export function hasPatch(row: TransactionRow, patch: TransactionPatch) {
  return patchEntries(patch).every(([column, value]) => row[column] === value);
}

/** `row`'s values for the columns `patch` sets: the patch that would put them back. */
export function patchFrom(row: TransactionRow, patch: TransactionPatch): TransactionPatch {
  // The same columns as `patch`, so the same kind of patch.
  return Object.fromEntries(
    patchEntries(patch).map(([column]) => [column, row[column]]),
  ) as TransactionPatch;
}
