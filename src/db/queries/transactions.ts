/**
 * SQL for the transactions page. Kept as named statements, not inline in
 * components, so the validate-database script can import and check them.
 */

/**
 * Amounts are stored as the actual amount × 10000, rounded: four decimals,
 * the most any ISO 4217 currency uses (e.g. CLF).
 */
export const AMOUNT_SCALE = 10_000;
export const AMOUNT_DECIMALS = 4;

/** The columns the transactions page shows. Amounts are × `AMOUNT_SCALE`. */
export type TransactionRow = {
  id: string;
  naive_date: string;
  account_name: string;
  counterparty: string;
  category: string | null;
  amount: number;
  currency: string;
  remarks: string | null;
};

/** Newest first. Rows on the same day keep their import order, latest first. */
export const LIST_TRANSACTIONS = `
  SELECT id, naive_date, account_name, counterparty, category, amount, currency, remarks
  FROM transactions
  ORDER BY naive_date DESC, seq DESC
`;

/** One row of `LIST_TRANSACTIONS`. Bind `[id]`. */
export const GET_TRANSACTION = `
  SELECT id, naive_date, account_name, counterparty, category, amount, currency, remarks
  FROM transactions
  WHERE id = ?
`;

export const LIST_CATEGORY_NAMES = `SELECT name FROM categories ORDER BY name`;

/** The columns an edit may change, each with its UPDATE. Bind `[value, id]`. */
export const UPDATE_TRANSACTION = {
  naive_date: `UPDATE transactions SET naive_date = ? WHERE id = ?`,
  counterparty: `UPDATE transactions SET counterparty = ? WHERE id = ?`,
  category: `UPDATE transactions SET category = ? WHERE id = ?`,
  amount: `UPDATE transactions SET amount = ? WHERE id = ?`,
  remarks: `UPDATE transactions SET remarks = ? WHERE id = ?`,
} as const satisfies Partial<Record<keyof TransactionRow, string>>;

export type EditableTransactionField = keyof typeof UPDATE_TRANSACTION;
