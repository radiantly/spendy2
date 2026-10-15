/**
 * SQL for the overview page. Kept as named statements, not inline in
 * components, so the validate-database script can import and check them.
 *
 * Totals are in one base currency: a transaction counts in it when its
 * amount is in that currency, or it has a conversion to it. Transfers between
 * the user's own accounts and transactions marked as duplicates are left out of spending
 * and income. Totals are summed as floats, in whole units of the currency
 * (12.5 for 12.50); dates are `YYYY-MM-DD`.
 */

/** The float value of the amount stored in `table`. */
const amountOf = (table: string) =>
  `(${table}.amount_numerator * 1.0 / ${table}.amount_denominator)`;

/**
 * The transactions from `$from` to `$to` (inclusive), with
 * - `base_amount`: the amount in `$base`, or null if there's none
 * - `counted`: whether it counts towards spending and income
 */
const IN_PERIOD = `
  WITH t AS (
    SELECT transactions.*,
      CASE
        WHEN transactions.currency = $base THEN ${amountOf("transactions")}
        ELSE ${amountOf("conversion")}
      END AS base_amount,
      transfer_account IS NULL AND duplicate_of IS NULL AS counted
    FROM transactions
    LEFT JOIN conversions AS conversion
      ON conversion.transaction_id = transactions.id AND conversion.currency = $base
    WHERE naive_date BETWEEN $from AND $to
  )
`;

export type OverviewMeta = {
  /** The currency most transactions have an amount in, their own or a conversion. */
  base_currency: string | null;
  first_date: string | null;
  last_date: string | null;
  /** Unix seconds. */
  last_import: number | null;
};

/** What the rest of the queries need to know first. No binds. */
export const GET_OVERVIEW_META = `
  SELECT
    (SELECT currency
      FROM (SELECT currency FROM transactions UNION ALL SELECT currency FROM conversions)
      GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1) AS base_currency,
    (SELECT min(naive_date) FROM transactions) AS first_date,
    (SELECT max(naive_date) FROM transactions) AS last_date,
    (SELECT max(import_timestamp) FROM sources) AS last_import
`;

export type PeriodSummary = {
  spent: number;
  income: number;
  /** Every transaction in the period, transfers and duplicates too. */
  transactions: number;
  /** Counted transactions without a category. */
  uncategorized: number;
  /** Counted transactions left out of the totals for having no amount in the base currency. */
  unconverted: number;
};

/** One row. Bind `{ $base, $from, $to }`. */
export const GET_PERIOD_SUMMARY = `${IN_PERIOD}
  SELECT
    coalesce(sum(CASE WHEN counted AND base_amount < 0 THEN -base_amount END), 0) AS spent,
    coalesce(sum(CASE WHEN counted AND base_amount > 0 THEN base_amount END), 0) AS income,
    count(*) AS transactions,
    count(CASE WHEN counted AND category IS NULL THEN 1 END) AS uncategorized,
    count(CASE WHEN counted AND base_amount IS NULL THEN 1 END) AS unconverted
  FROM t
`;

export type DailySpending = { date: string; spent: number };

/** Only days with spending, oldest first. Bind `{ $base, $from, $to }`. */
export const LIST_DAILY_SPENDING = `${IN_PERIOD}
  SELECT naive_date AS date, sum(-base_amount) AS spent
  FROM t
  WHERE counted AND base_amount < 0
  GROUP BY naive_date
  ORDER BY naive_date
`;

export type CategorySpending = { category: string | null; spent: number };

/**
 * Spending per category (null: none), as the categories table spells the
 * name. Bind `{ $base, $from, $to }`.
 */
export const LIST_CATEGORY_SPENDING = `${IN_PERIOD}
  SELECT coalesce(categories.name, t.category) AS category, sum(-base_amount) AS spent
  FROM t LEFT JOIN categories ON categories.name = t.category
  WHERE counted AND base_amount < 0
  GROUP BY 1
`;

export type CategoryParent = { name: string; parent: string | null };

/** Every category with its parent, as the categories table spells both. */
export const LIST_CATEGORY_PARENTS = `
  SELECT category.name, parent.name AS parent
  FROM categories AS category LEFT JOIN categories AS parent ON parent.name = category.parent
`;

export type MonthlyTotals = { month: string; income: number; spent: number };

/** Only months with counted transactions, as `YYYY-MM`. Bind `{ $base, $from, $to }`. */
export const LIST_MONTHLY_TOTALS = `${IN_PERIOD}
  SELECT
    substr(naive_date, 1, 7) AS month,
    coalesce(sum(CASE WHEN base_amount > 0 THEN base_amount END), 0) AS income,
    coalesce(sum(CASE WHEN base_amount < 0 THEN -base_amount END), 0) AS spent
  FROM t
  WHERE counted
  GROUP BY 1
  ORDER BY 1
`;

export type AccountActivity = {
  name: string;
  currency: string;
  transactions: number;
  money_in: number;
  /** Positive. */
  money_out: number;
  /** Net of transfers to and from the user's other accounts. */
  transfers: number;
};

/**
 * Every account with a default currency, busiest first. The amounts are in
 * that currency; its transactions in other currencies are only counted in
 * `transactions`. Bind `{ $from, $to }`.
 */
export const LIST_ACCOUNT_ACTIVITY = `
  SELECT
    account.name,
    account.default_currency AS currency,
    count(t.id) AS transactions,
    coalesce(sum(CASE WHEN t.transfer_account IS NULL AND t.duplicate_of IS NULL
      AND t.currency = account.default_currency AND t.amount > 0 THEN t.amount END), 0) AS money_in,
    coalesce(sum(CASE WHEN t.transfer_account IS NULL AND t.duplicate_of IS NULL
      AND t.currency = account.default_currency AND t.amount < 0 THEN -t.amount END), 0) AS money_out,
    coalesce(sum(CASE WHEN t.transfer_account IS NOT NULL AND t.duplicate_of IS NULL
      AND t.currency = account.default_currency THEN t.amount END), 0) AS transfers
  FROM accounts AS account
  LEFT JOIN (SELECT *, ${amountOf("transactions")} AS amount FROM transactions) AS t
    ON t.account_name = account.name AND t.naive_date BETWEEN $from AND $to
  WHERE account.default_currency IS NOT NULL
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
  /** The amount's conversion to `$base`, if it has one (never when it's in `$base`). */
  base_numerator: number | null;
  base_denominator: number | null;
};

/**
 * The latest transactions in the period, newest first. Bind
 * `{ $base, $from, $to, $limit }`.
 */
export const LIST_RECENT_TRANSACTIONS = `
  SELECT
    t.id, t.naive_date, t.counterparty, t.account_name,
    coalesce(category.name, t.category) AS category,
    parent.name AS category_parent,
    t.transfer_account,
    t.duplicate_of IS NOT NULL AS duplicate,
    t.amount_numerator, t.amount_denominator, t.currency,
    conversion.amount_numerator AS base_numerator,
    conversion.amount_denominator AS base_denominator
  FROM transactions AS t
  LEFT JOIN categories AS category ON category.name = t.category
  LEFT JOIN categories AS parent ON parent.name = category.parent
  LEFT JOIN conversions AS conversion
    ON conversion.transaction_id = t.id AND conversion.currency = $base
  WHERE t.naive_date BETWEEN $from AND $to
  ORDER BY t.naive_date DESC, t.seq DESC
  LIMIT $limit
`;
