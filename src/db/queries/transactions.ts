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
 * A transaction as the page loads it: its row, and what no edit changes:
 * what the list on narrow screens also shows, and its place in order.
 */
export type ListedTransaction = TransactionRow & {
  /** When it happened, in seconds since the Unix epoch, if known. */
  timestamp: number | null;
  /** Orders the transactions on a day after their times (see `newestFirst`). */
  sort_key: number;
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
  'timestamp', transactions.timestamp, 'sort_key', transactions.sort_key,
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
 * The order of transactions, newest first (see the schema): by date; on the
 * same day, by time, those without one last, as if at the start of the day;
 * then by sort key, then id. `table` is the transactions' name in the query.
 */
export const newestFirst = (table: string) =>
  `${table}.naive_date DESC, ${table}.timestamp DESC NULLS LAST, ${table}.sort_key DESC, ${table}.id DESC`;

/** What orders transactions. */
type Ordered = Pick<ListedTransaction, "id" | "naive_date" | "timestamp" | "sort_key">;

/** `newestFirst` in JavaScript, for sorting transactions newest first. */
export function compareNewestFirst(x: Ordered, y: Ordered) {
  if (x.naive_date !== y.naive_date) return x.naive_date < y.naive_date ? 1 : -1;
  // Those without a time last, as if at the start of the day.
  if (x.timestamp !== y.timestamp) return (y.timestamp ?? -Infinity) - (x.timestamp ?? -Infinity);
  if (x.sort_key !== y.sort_key) return y.sort_key - x.sort_key;
  return x.id === y.id ? 0 : x.id < y.id ? 1 : -1;
}

/** Newest first (see `newestFirst`). Read the result with `listedTransactions`. */
export const LIST_TRANSACTIONS = `
  SELECT json_group_array(
    ${LISTED_JSON} ORDER BY ${newestFirst("transactions")}
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

/**
 * Every category with its parent, as the categories table spells both,
 * alphabetical, ignoring case (the names are `COLLATE NOCASE`). Read the result
 * as `CategoryParent`s.
 */
export const LIST_CATEGORIES = `
  SELECT category.name, parent.name AS parent
  FROM categories AS category LEFT JOIN categories AS parent ON parent.name = category.parent
  ORDER BY category.name
`;

/** A currency, with the decimals its amounts are stored in. */
export type Currency = { code: string; stored_decimals: number };

/** Every currency, by code. */
export const LIST_CURRENCIES = `SELECT code, stored_decimals FROM currencies ORDER BY code`;

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
  // An amount is in its currency's decimals, so the three are set together.
  amount: Pick<TransactionRow, "currency" | "amount" | "decimals">;
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
  amount: `UPDATE transactions SET currency = $currency, amount = $amount WHERE id = $id`,
  remarks: `UPDATE transactions SET remarks = $remarks WHERE id = $id`,
} as const satisfies Record<EditableTransactionField, string>;

/**
 * What a transaction is to others, as marking it sets: the transaction it's
 * a duplicate of, and the account it's a transfer with.
 */
export type TransactionMarkField = "duplicate_of" | "transfer_account";

/** Each mark's UPDATE. Bind `[value, id]`. */
export const UPDATE_MARK = {
  duplicate_of: `UPDATE transactions SET duplicate_of = ? WHERE id = ?`,
  transfer_account: `UPDATE transactions SET transfer_account = ? WHERE id = ?`,
} as const satisfies Record<TransactionMarkField, string>;

/**
 * Deletes a transaction's conversion to a currency. A transaction can't be
 * converted to its own currency, so this goes before setting its currency to
 * one it has a conversion to. Bind `[id, currency]`.
 */
export const DELETE_CONVERSION = `DELETE FROM conversions WHERE transaction_id = ? AND currency = ?`;

/** A source, unless one with its hash exists. Bind `[hash, remarks]`. */
export const INSERT_SOURCE = `INSERT INTO sources (hash, remarks) VALUES (?, ?) ON CONFLICT DO NOTHING`;

/**
 * A transaction, without a transfer, a duplicate or conversions. Bind with
 * `insertBinds`.
 */
export const INSERT_TRANSACTION = `
  INSERT INTO transactions (id, source, account_name, currency, amount, counterparty, category,
    naive_date, timestamp, sort_key, remarks)
  VALUES ($id, $source, $account_name, $currency, $amount, $counterparty, $category,
    $naive_date, $timestamp, $sort_key, $remarks)
`;

/** The binds for `INSERT_TRANSACTION`: `transaction`'s columns, from the source `source`. */
export function insertBinds(transaction: ListedTransaction, source: Uint8Array) {
  return {
    $id: transaction.id,
    $source: source,
    $account_name: transaction.account_name,
    $currency: transaction.currency,
    $amount: transaction.amount,
    $counterparty: transaction.counterparty,
    $category: transaction.category,
    $naive_date: transaction.naive_date,
    $timestamp: transaction.timestamp,
    $sort_key: transaction.sort_key,
    $remarks: transaction.remarks,
  };
}

/** Sets a transaction's sort key. Bind `[sortKey, id]`. */
export const UPDATE_SORT_KEY = `UPDATE transactions SET sort_key = ? WHERE id = ?`;

/**
 * Deletes transactions by id, and with them, as the schema has it, their
 * conversions, others being duplicates of them, and categories only they
 * used. Bind `[JSON.stringify(ids)]`.
 */
export const DELETE_TRANSACTIONS = `DELETE FROM transactions WHERE id IN (SELECT value FROM json_each(?))`;

/** What a patch can set that isn't a column of transactions: the decimals are its currency's. */
const NOT_STORED: ReadonlySet<string> = new Set<keyof TransactionRow>(["decimals"]);

/** The binds for `UPDATE_TRANSACTION`: each stored column of `patch` as `$column`, and `$id`. */
export function updateBinds(patch: TransactionPatch, id: string) {
  const binds: Record<string, string | number | null> = { $id: id };
  for (const [column, value] of Object.entries(patch))
    if (!NOT_STORED.has(column)) binds[`$${column}`] = value;
  return binds;
}

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
