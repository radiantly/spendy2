/**
 * SQL for the overview page. Kept as named statements, not inline in
 * components, so the validate-database script can import and check them.
 *
 * The overview is in one display currency, and covers the transactions in
 * accounts shown in it, as well as those in it in accounts without a display
 * currency (see OVERVIEW_CURRENCY). A transaction in another currency counts
 * through its conversion to it, and without one is left out of the totals.
 * Transfers between the user's own accounts and transactions marked as
 * duplicates are left out of spending and income. Totals are summed as
 * floats, in whole units of the currency (12.5 for 12.50); dates are
 * `YYYY-MM-DD`.
 */

/** The float value of the amount stored in `table`. */
const amountOf = (table: string) =>
  `(${table}.amount_numerator * 1.0 / ${table}.amount_denominator)`;

/**
 * The display currency whose overview a transaction is in: its account's, or
 * its own when the account has none (its transactions stay in their own
 * currencies). Needs `transactions` joined with its `account`.
 */
const OVERVIEW_CURRENCY = "coalesce(account.display_currency, transactions.currency)";

/**
 * The transactions from `$from` to `$to` (inclusive) in the overview in
 * `$display`, with
 * - `display_amount`: the amount in `$display`, or null if there's none
 * - `display_numerator`, `display_denominator`: the amount's conversion to
 *   `$display`, if it has one (never when it's in `$display`)
 * - `counted`: whether it counts towards spending and income
 */
const IN_PERIOD = `
  WITH t AS (
    SELECT transactions.*,
      CASE
        WHEN transactions.currency = $display THEN ${amountOf("transactions")}
        ELSE ${amountOf("conversion")}
      END AS display_amount,
      conversion.amount_numerator AS display_numerator,
      conversion.amount_denominator AS display_denominator,
      transfer_account IS NULL AND duplicate_of IS NULL AS counted
    FROM transactions
    JOIN accounts AS account ON account.name = transactions.account_name
    LEFT JOIN conversions AS conversion
      ON conversion.transaction_id = transactions.id AND conversion.currency = $display
    WHERE naive_date BETWEEN $from AND $to AND ${OVERVIEW_CURRENCY} = $display
  )
`;

export type CurrencyUse = { currency: string };

/**
 * Every display currency with an overview, the one with the most
 * transactions first, then by name. No binds.
 */
export const LIST_CURRENCIES = `
  SELECT ${OVERVIEW_CURRENCY} AS currency
  FROM transactions JOIN accounts AS account ON account.name = transactions.account_name
  GROUP BY 1
  ORDER BY count(*) DESC, 1
`;

export type OverviewMeta = {
  first_date: string | null;
  last_date: string | null;
  /** Unix seconds. */
  last_import: number | null;
};

/** What the rest of the queries need to know first. No binds. */
export const GET_OVERVIEW_META = `
  SELECT
    (SELECT min(naive_date) FROM transactions) AS first_date,
    (SELECT max(naive_date) FROM transactions) AS last_date,
    (SELECT max(import_timestamp) FROM sources) AS last_import
`;

export type PeriodSummary = {
  spent: number;
  income: number;
  /** Every transaction, transfers and duplicates too. */
  transactions: number;
  /** Counted transactions without a category. */
  uncategorized: number;
  /**
   * Counted transactions with no amount in the display currency, so left
   * out of the totals. Only an account shown in it has any.
   */
  unconverted: number;
  /**
   * Transactions in other currencies than the display currency (so in
   * accounts shown in it), transfers and duplicates too.
   */
  foreign_currency: number;
};

/** One row. Bind `{ $display, $from, $to }`. */
export const GET_PERIOD_SUMMARY = `${IN_PERIOD}
  SELECT
    coalesce(sum(CASE WHEN counted AND display_amount < 0 THEN -display_amount END), 0) AS spent,
    coalesce(sum(CASE WHEN counted AND display_amount > 0 THEN display_amount END), 0) AS income,
    count(*) AS transactions,
    count(CASE WHEN counted AND category IS NULL THEN 1 END) AS uncategorized,
    count(CASE WHEN counted AND display_amount IS NULL THEN 1 END) AS unconverted,
    count(CASE WHEN currency <> $display THEN 1 END) AS foreign_currency
  FROM t
`;

export type DailySpending = { date: string; spent: number };

/** Only days with spending, oldest first. Bind `{ $display, $from, $to }`. */
export const LIST_DAILY_SPENDING = `${IN_PERIOD}
  SELECT naive_date AS date, sum(-display_amount) AS spent
  FROM t
  WHERE counted AND display_amount < 0
  GROUP BY naive_date
  ORDER BY naive_date
`;

export type CategorySpending = { category: string | null; spent: number };

/**
 * Spending per category (null: none), as the categories table spells the
 * name. Bind `{ $display, $from, $to }`.
 */
export const LIST_CATEGORY_SPENDING = `${IN_PERIOD}
  SELECT coalesce(categories.name, t.category) AS category, sum(-display_amount) AS spent
  FROM t LEFT JOIN categories ON categories.name = t.category
  WHERE counted AND display_amount < 0
  GROUP BY 1
`;

export type CategoryParent = { name: string; parent: string | null };

/** Every category with its parent, as the categories table spells both. */
export const LIST_CATEGORY_PARENTS = `
  SELECT category.name, parent.name AS parent
  FROM categories AS category LEFT JOIN categories AS parent ON parent.name = category.parent
`;

export type MonthlyTotals = { month: string; income: number; spent: number };

/** Only months with counted transactions, as `YYYY-MM`. Bind `{ $display, $from, $to }`. */
export const LIST_MONTHLY_TOTALS = `${IN_PERIOD}
  SELECT
    substr(naive_date, 1, 7) AS month,
    coalesce(sum(CASE WHEN display_amount > 0 THEN display_amount END), 0) AS income,
    coalesce(sum(CASE WHEN display_amount < 0 THEN -display_amount END), 0) AS spent
  FROM t
  WHERE counted
  GROUP BY 1
  ORDER BY 1
`;

export type AccountActivity = {
  name: string;
  type: string;
  identifier: string | null;
} & (
  | {
      /** The account's display currency, which money in and out are in. */
      currency: string;
      money_in: number;
      /** Positive. */
      money_out: number;
    }
  /** Without a display currency, its transactions stay in their own currencies. */
  | { currency: null; money_in: null; money_out: null }
);

/**
 * Every account, the one with the most transactions in the period first.
 * Money in and out leave out transfers to and from the user's other
 * accounts, and are in the account's display currency: a transaction in
 * another currency counts through its conversion to it, and one without a
 * conversion only counts towards the account's place in the order.
 * Bind `{ $from, $to }`.
 */
export const LIST_ACCOUNT_ACTIVITY = `
  WITH t AS (
    SELECT transactions.id, transactions.account_name,
      CASE
        WHEN transactions.currency = account.display_currency THEN ${amountOf("transactions")}
        ELSE ${amountOf("conversion")}
      END AS amount,
      transfer_account IS NULL AND duplicate_of IS NULL AS counted
    FROM transactions
    JOIN accounts AS account ON account.name = transactions.account_name
    LEFT JOIN conversions AS conversion
      ON conversion.transaction_id = transactions.id
      AND conversion.currency = account.display_currency
    WHERE naive_date BETWEEN $from AND $to
  )
  SELECT
    account.name,
    account.type,
    account.identifier,
    account.display_currency AS currency,
    CASE WHEN account.display_currency IS NOT NULL
      THEN coalesce(sum(CASE WHEN counted AND amount > 0 THEN amount END), 0) END AS money_in,
    CASE WHEN account.display_currency IS NOT NULL
      THEN coalesce(sum(CASE WHEN counted AND amount < 0 THEN -amount END), 0) END AS money_out
  FROM accounts AS account
  LEFT JOIN t ON t.account_name = account.name
  GROUP BY account.name
  ORDER BY count(t.id) DESC, account.name
`;

export type RecentTransaction = {
  id: string;
  naive_date: string;
  counterparty: string;
  account_name: string;
  category: string | null;
  category_parent: string | null;
  transfer_account: string | null;
  /** 1 if it's marked as a duplicate of another transaction, else 0. */
  duplicate: number;
  amount_numerator: number;
  amount_denominator: number;
  currency: string;
  /** The amount's conversion to `$display`, if it has one (never when it's in `$display`). */
  display_numerator: number | null;
  display_denominator: number | null;
};

/**
 * The latest transactions in the period, newest first. Bind
 * `{ $display, $from, $to, $limit }`.
 */
export const LIST_RECENT_TRANSACTIONS = `${IN_PERIOD}
  SELECT
    t.id, t.naive_date, t.counterparty, t.account_name,
    coalesce(category.name, t.category) AS category,
    parent.name AS category_parent,
    t.transfer_account,
    t.duplicate_of IS NOT NULL AS duplicate,
    t.amount_numerator, t.amount_denominator, t.currency,
    t.display_numerator, t.display_denominator
  FROM t
  LEFT JOIN categories AS category ON category.name = t.category
  LEFT JOIN categories AS parent ON parent.name = category.parent
  ORDER BY t.naive_date DESC, t.seq DESC
  LIMIT $limit
`;
