/**
 * SQL for the overview page. Kept as named statements, not inline in
 * components, so the validate-database script can import and check them.
 *
 * The overview is in one display currency, and covers the transactions in
 * accounts shown in it, as well as those in it in accounts without a display
 * currency (see overviewCurrency). A transaction in another currency counts
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
 * The display currency whose overview a transaction in `transactions` is in:
 * its account's, or its own when the account has none (its transactions stay
 * in their own currencies). Needs it joined with its `account`.
 */
const overviewCurrency = (transactions: string) =>
  `coalesce(account.display_currency, ${transactions}.currency)`;

/**
 * The transactions from `$from` to `$to` (inclusive) that also meet
 * `condition`, with
 * - `display_amount`: the amount in the display currency whose overview it's
 *   in (see overviewCurrency): its own, or its conversion to it. Null if
 *   there's none.
 * - `display_numerator`, `display_denominator`: that conversion, if it has
 *   one (never when it's in that currency)
 * - `counted`: whether it counts towards spending and income: it's neither a
 *   transfer between the user's own accounts nor marked as a duplicate
 */
const inPeriod = (condition: string) => `
  WITH t AS (
    SELECT transactions.*,
      CASE
        WHEN transactions.currency = ${overviewCurrency("transactions")}
          THEN ${amountOf("transactions")}
        ELSE ${amountOf("conversion")}
      END AS display_amount,
      conversion.amount_numerator AS display_numerator,
      conversion.amount_denominator AS display_denominator,
      transfer_account IS NULL AND duplicate_of IS NULL AS counted
    FROM transactions
    JOIN accounts AS account ON account.name = transactions.account_name
    LEFT JOIN conversions AS conversion
      ON conversion.transaction_id = transactions.id
      AND conversion.currency = ${overviewCurrency("transactions")}
    WHERE naive_date BETWEEN $from AND $to AND ${condition}
  )
`;

/** The period's transactions in the overview in `$display` (see inPeriod). */
const IN_PERIOD = inPeriod(`${overviewCurrency("transactions")} = $display`);

export type CurrencyUse = { currency: string };

/**
 * Every display currency with an overview, the one with the most
 * transactions first, then by name. No binds. Each account's currencies are
 * counted first, from transactions_account_currency, so only those few rows
 * are grouped by their overview's currency.
 */
export const LIST_CURRENCIES = `
  SELECT ${overviewCurrency("used")} AS currency
  FROM (
    SELECT account_name, currency, count(*) AS transactions
    FROM transactions
    GROUP BY account_name, currency
  ) AS used
  JOIN accounts AS account ON account.name = used.account_name
  GROUP BY 1
  ORDER BY sum(used.transactions) DESC, 1
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
   * Counted transactions spending money in other currencies than the display
   * currency (so in accounts shown in it).
   */
  foreign_currency_spends: number;
};

/** One row. Bind `{ $display, $from, $to }`. */
export const GET_PERIOD_SUMMARY = `${IN_PERIOD}
  SELECT
    coalesce(sum(CASE WHEN counted AND display_amount < 0 THEN -display_amount END), 0) AS spent,
    coalesce(sum(CASE WHEN counted AND display_amount > 0 THEN display_amount END), 0) AS income,
    count(*) AS transactions,
    count(CASE WHEN counted AND category IS NULL THEN 1 END) AS uncategorized,
    count(CASE WHEN counted AND display_amount IS NULL THEN 1 END) AS unconverted,
    count(CASE WHEN counted AND currency <> $display AND amount_numerator < 0 THEN 1 END)
      AS foreign_currency_spends
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
  /** How many currencies its counted transactions in the period are in. */
  currencies: number;
} & (
  | {
      /**
       * What money in and out are in: the account's display currency, or
       * without one, the one currency its counted transactions are in.
       */
      currency: string;
      money_in: number;
      /** Positive. */
      money_out: number;
    }
  /** Without a display currency, its counted transactions aren't in just one. */
  | { currency: null; money_in: null; money_out: null }
);

/**
 * Every account, the one with the most transactions in the period first.
 * Money in and out leave out transfers to and from the user's other
 * accounts and duplicates. They're in the account's display currency: a
 * transaction in another currency counts through its conversion to it, and
 * one without a conversion only counts towards the account's place in the
 * order. An account without a display currency has them only when its
 * transactions are all in one currency. Bind `{ $from, $to }`.
 */
export const LIST_ACCOUNT_ACTIVITY = `${inPeriod("TRUE")}
  SELECT name, type, identifier, currencies, currency,
    CASE WHEN currency IS NOT NULL THEN money_in END AS money_in,
    CASE WHEN currency IS NOT NULL THEN money_out END AS money_out
  FROM (
    SELECT
      account.name,
      account.type,
      account.identifier,
      count(DISTINCT CASE WHEN counted THEN t.currency END) AS currencies,
      coalesce(
        account.display_currency,
        CASE WHEN count(DISTINCT CASE WHEN counted THEN t.currency END) = 1
          THEN max(CASE WHEN counted THEN t.currency END) END
      ) AS currency,
      coalesce(sum(CASE WHEN counted AND display_amount > 0 THEN display_amount END), 0) AS money_in,
      coalesce(sum(CASE WHEN counted AND display_amount < 0 THEN -display_amount END), 0) AS money_out,
      count(t.id) AS transactions
    FROM accounts AS account
    LEFT JOIN t ON t.account_name = account.name
    GROUP BY account.name
  )
  ORDER BY transactions DESC, name
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
