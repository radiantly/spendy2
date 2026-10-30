/**
 * What marking transactions as duplicates or as a transfer sets (see
 * `markTransactions`): which transactions change, and to what. And what a
 * transaction's remarks say it's marked as.
 */
import type { ListedTransaction, TransactionRow } from "../../db/queries/transactions.ts";
import type { TransactionMark, Transactions } from "../../db/transactions.ts";

/** What transactions are marked as: duplicates of another, or a transfer with another. */
export type MarkKind = "duplicate" | "transfer";

/**
 * The transaction `id` is ultimately a duplicate of: the one at the end of
 * what each is a duplicate of, or `id` if it isn't one. Imported ones can
 * loop, so it stops at one it's already been to, taking the last before it.
 */
function originalOf(id: string, transactionOf: (id: string) => ListedTransaction | undefined) {
  const seen = new Set([id]);
  let current = id;
  for (;;) {
    const next = transactionOf(current)?.duplicate_of;
    if (next == null || seen.has(next) || transactionOf(next) === undefined) return current;
    seen.add(next);
    current = next;
  }
}

/**
 * The marks that make the transactions `marked` duplicates of the one that
 * `picked` is a duplicate of (see `originalOf`), so none is ever a duplicate
 * of a duplicate:
 * - If that original is one of `marked`, `picked` is the original instead:
 *   picking one of them, or a duplicate of one, picks the original among them.
 * - The original isn't a duplicate of anything.
 * - Those that were duplicates of one of `marked` move on to the original.
 *
 * Only marks that change something are given, so none if nothing would.
 */
export function duplicateMarks(
  { rows, positions, removed }: Pick<Transactions, "rows" | "positions" | "removed">,
  marked: readonly string[],
  picked: string,
): TransactionMark[] {
  const transactionOf = (id: string) => {
    const position = positions.get(id);
    return position === undefined || removed.has(position) ? undefined : rows[position];
  };
  const root = originalOf(picked, transactionOf);
  const original = marked.includes(root) ? picked : root;
  const duplicates = new Set(marked.filter((id) => id !== original));

  const marks: TransactionMark[] = [];
  const mark = ({ id, duplicate_of }: ListedTransaction, value: string | null) => {
    if (duplicate_of !== value) marks.push({ id, field: "duplicate_of", value });
  };
  mark(transactionOf(original)!, null);
  for (const id of duplicates) mark(transactionOf(id)!, original);
  rows.forEach((row, position) => {
    if (
      row.duplicate_of !== null &&
      duplicates.has(row.duplicate_of) &&
      !duplicates.has(row.id) &&
      row.id !== original &&
      !removed.has(position)
    )
      mark(row, original);
  });
  return marks;
}

/**
 * Whether two account names are one account. They're compared as the
 * schema compares them, `COLLATE NOCASE`, which folds only A to Z.
 */
function sameAccount(x: string, y: string) {
  const fold = (name: string) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  return fold(x) === fold(y);
}

type TransferSide = Pick<ListedTransaction, "id" | "account_name" | "transfer_account">;

/**
 * The marks that make `marked` and `picked` the two sides of a transfer,
 * each a transfer with the other's account. None if they're in the same
 * account, which a transfer can't be, or if nothing would change.
 */
export function transferMarks(marked: TransferSide, picked: TransferSide): TransactionMark[] {
  if (sameAccount(marked.account_name, picked.account_name)) return [];
  const sides: [TransferSide, TransferSide][] = [
    [marked, picked],
    [picked, marked],
  ];
  return sides.flatMap(([side, other]): TransactionMark[] =>
    side.transfer_account === other.account_name
      ? []
      : [{ id: side.id, field: "transfer_account", value: other.account_name }],
  );
}

/**
 * What `row` is marked as, for its remarks cell to say after its remarks:
 * "Transfer from Savings." for money in, or "to" for money out, and
 * "Duplicate of transaction 3." by the original's row number, if it's shown
 * (`rowNumberOf` gives it, by id). Null if it's neither.
 */
export function marksNote(
  { amount, transfer_account, duplicate_of }: TransactionRow,
  rowNumberOf: (id: string) => number | undefined,
): string | null {
  const notes: string[] = [];
  if (transfer_account !== null)
    notes.push(`Transfer ${amount > 0 ? "from" : "to"} ${transfer_account}.`);
  if (duplicate_of !== null) {
    const number = rowNumberOf(duplicate_of);
    notes.push(
      number === undefined
        ? "Duplicate of a hidden transaction."
        : `Duplicate of transaction ${number}.`,
    );
  }
  return notes.length === 0 ? null : notes.join(" ");
}
