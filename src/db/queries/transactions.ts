/**
 * SQL for the transactions page. Kept as named statements, not inline in
 * components, so the validate-database script can import and check them.
 */

import type { Amount } from "../../lib/money.ts";

/**
 * The columns the transactions page shows. `amount` is in `decimals`, its
 * currency's stored_decimals, so the row is also its `Amount`.
 */
export type TransactionRow = {
  id: string;
  naive_date: string;
  account_name: string;
  counterparty: string;
  category: string | null;
  amount: number;
  decimals: number;
  currency: string;
  remarks: string | null;
};

/**
 * A transaction as the page loads it: its row, and what the list on narrow
 * screens also shows, which no edit changes.
 */
export type ListedTransaction = TransactionRow & {
  transfer_account: string | null;
  duplicate_of: string | null;
  /** Its amount in other currencies: `{ USD: { amount: -1090, decimals: 2 } }`. */
  conversions: Record<string, Amount>;
};

/** `transaction`'s amount in `currency`, if it has a conversion to it. */
export function conversionTo(
  transaction: Pick<ListedTransaction, "conversions">,
  currency: string,
): Amount | undefined {
  return transaction.conversions[currency];
}

/**
 * A transaction as a JSON object of `ListedTransaction`'s fields. The queries
 * return them all as one JSON array, built by SQLite: reading each row's
 * columns into JavaScript takes several times as long for many rows.
 */
const LISTED_JSON = `json_object(
  'id', transactions.id, 'naive_date', transactions.naive_date,
  'account_name', transactions.account_name, 'counterparty', transactions.counterparty,
  'category', transactions.category, 'amount', transactions.amount,
  'decimals', currencies.stored_decimals, 'currency', transactions.currency,
  'remarks', transactions.remarks, 'transfer_account', transactions.transfer_account,
  'duplicate_of', transactions.duplicate_of,
  -- json() so it's an object, not a string of one.
  'conversions', json((
    SELECT json_group_object(
      conversion.currency,
      json_object('amount', conversion.amount, 'decimals', conversion_currency.stored_decimals)
    )
    FROM conversions AS conversion
    JOIN currencies AS conversion_currency ON conversion_currency.code = conversion.currency
    WHERE conversion.transaction_id = transactions.id
  ))
)`;

const LISTED_FROM = `
  FROM transactions
  JOIN currencies ON currencies.code = transactions.currency
`;

/**
 * Newest first. Rows on the same day keep their import order, latest first.
 * Read the result with `listedTransactions`.
 */
export const LIST_TRANSACTIONS = `
  SELECT json_group_array(
    ${LISTED_JSON} ORDER BY transactions.naive_date DESC, transactions.seq DESC
  ) AS transactions
  ${LISTED_FROM}
`;

/**
 * Transactions of `LIST_TRANSACTIONS`, by id. Bind `[JSON.stringify(ids)]`.
 * Read the result with `listedTransactions`.
 */
export const GET_TRANSACTIONS = `
  SELECT json_group_array(${LISTED_JSON}) AS transactions
  ${LISTED_FROM}
  WHERE transactions.id IN (SELECT value FROM json_each(?))
`;

/** The transactions in a result of `LIST_TRANSACTIONS` or `GET_TRANSACTIONS`. */
export function listedTransactions(result: readonly Record<string, unknown>[]) {
  // The query builds the JSON, so its shape is known.
  return JSON.parse(String(result[0]!.transactions)) as ListedTransaction[];
}

/** Alphabetical, ignoring case (the names are `COLLATE NOCASE`). */
export const LIST_CATEGORY_NAMES = `SELECT name FROM categories ORDER BY name`;

export type AccountCurrency = { name: string; display_currency: string | null };

/**
 * Every account with its display currency, alphabetical, ignoring case (the
 * names are `COLLATE NOCASE`).
 */
export const LIST_ACCOUNTS = `SELECT name, display_currency FROM accounts ORDER BY name`;

/** A top-level category, unless one with that name (in any case) exists. Bind `[name]`. */
export const INSERT_CATEGORY = `INSERT INTO categories (name) VALUES (?) ON CONFLICT DO NOTHING`;

/** The fields an edit may change, each with the columns it sets. */
type TransactionFieldColumns = {
  naive_date: Pick<TransactionRow, "naive_date">;
  account_name: Pick<TransactionRow, "account_name">;
  counterparty: Pick<TransactionRow, "counterparty">;
  category: Pick<TransactionRow, "category">;
  amount: Pick<TransactionRow, "amount">;
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
  amount: `UPDATE transactions SET amount = $amount WHERE id = $id`,
  remarks: `UPDATE transactions SET remarks = $remarks WHERE id = $id`,
} as const satisfies Record<EditableTransactionField, string>;

/** The binds for `UPDATE_TRANSACTION`: each column of `patch` as `$column`, and `$id`. */
export function updateBinds(patch: TransactionPatch, id: string) {
  const binds: Record<string, string | number | null> = { $id: id };
  for (const [column, value] of Object.entries(patch)) binds[`$${column}`] = value;
  return binds;
}
