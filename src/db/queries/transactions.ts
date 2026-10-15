/**
 * SQL for the transactions page. Kept as named statements, not inline in
 * components, so the validate-database script can import and check them.
 */

/** The columns the transactions page shows. The amount is the fraction numerator / denominator. */
export type TransactionRow = {
  id: string;
  naive_date: string;
  account_name: string;
  counterparty: string;
  category: string | null;
  amount_numerator: number;
  amount_denominator: number;
  currency: string;
  remarks: string | null;
};

/** Newest first. Rows on the same day keep their import order, latest first. */
export const LIST_TRANSACTIONS = `
  SELECT id, naive_date, account_name, counterparty, category,
    amount_numerator, amount_denominator, currency, remarks
  FROM transactions
  ORDER BY naive_date DESC, seq DESC
`;

/** Rows of `LIST_TRANSACTIONS`, by id. Bind `[JSON.stringify(ids)]`. */
export const GET_TRANSACTIONS = `
  SELECT id, naive_date, account_name, counterparty, category,
    amount_numerator, amount_denominator, currency, remarks
  FROM transactions
  WHERE id IN (SELECT value FROM json_each(?))
`;

/** Alphabetical, ignoring case (the names are `COLLATE NOCASE`). */
export const LIST_CATEGORY_NAMES = `SELECT name FROM categories ORDER BY name`;

/** Alphabetical, ignoring case (the names are `COLLATE NOCASE`). */
export const LIST_ACCOUNT_NAMES = `SELECT name FROM accounts ORDER BY name`;

/** A top-level category, unless one with that name (in any case) exists. Bind `[name]`. */
export const INSERT_CATEGORY = `INSERT INTO categories (name) VALUES (?) ON CONFLICT DO NOTHING`;

/** The fields an edit may change, each with the columns it sets. */
type TransactionFieldColumns = {
  naive_date: Pick<TransactionRow, "naive_date">;
  account_name: Pick<TransactionRow, "account_name">;
  counterparty: Pick<TransactionRow, "counterparty">;
  category: Pick<TransactionRow, "category">;
  amount: Pick<TransactionRow, "amount_numerator" | "amount_denominator">;
  remarks: Pick<TransactionRow, "remarks">;
};

export type EditableTransactionField = keyof TransactionFieldColumns;

/** A field of a transaction an edit changed. */
export type EditedCell = { id: string; field: EditableTransactionField };

/** New values for some of a transaction's columns, as an edit of one field sets them. */
export type TransactionPatch = TransactionFieldColumns[EditableTransactionField];

/** Each field's UPDATE. Bind with `updateBinds`. */
export const UPDATE_TRANSACTION = {
  naive_date: `UPDATE transactions SET naive_date = $naive_date WHERE id = $id`,
  account_name: `UPDATE transactions SET account_name = $account_name WHERE id = $id`,
  counterparty: `UPDATE transactions SET counterparty = $counterparty WHERE id = $id`,
  category: `UPDATE transactions SET category = $category WHERE id = $id`,
  amount: `
    UPDATE transactions
    SET amount_numerator = $amount_numerator, amount_denominator = $amount_denominator
    WHERE id = $id
  `,
  remarks: `UPDATE transactions SET remarks = $remarks WHERE id = $id`,
} as const satisfies Record<EditableTransactionField, string>;

/** The binds for `UPDATE_TRANSACTION`: each column of `patch` as `$column`, and `$id`. */
export function updateBinds(patch: TransactionPatch, id: string) {
  const binds: Record<string, string | number | null> = { $id: id };
  for (const [column, value] of Object.entries(patch)) binds[`$${column}`] = value;
  return binds;
}
