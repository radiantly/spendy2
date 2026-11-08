import { queryOptions } from "@tanstack/react-query";
import type { Database } from "../../db/database.ts";
import { databaseKey } from "../../db/queryClient.ts";
import {
  GET_OVERVIEW_META,
  GET_PERIOD_SUMMARY,
  HAS_TRANSACTIONS,
  LIST_ACCOUNT_ACTIVITY,
  LIST_CATEGORY_PARENTS,
  LIST_CATEGORY_SPENDING,
  LIST_CURRENCIES,
  LIST_DAILY_SPENDING,
  LIST_MONTHLY_TOTALS,
  LIST_RECENT_TRANSACTIONS,
  type AccountActivity,
  type CategoryParent,
  type CategorySpending,
  type CurrencyUse,
  type DailySpending,
  type MonthlyTotals,
  type OverviewMeta,
  type PeriodSummary,
  type RecentTransaction,
  type TransactionsFound,
} from "../../db/queries/overview.ts";
import {
  endOfMonth,
  monthsEnding,
  resolvePeriod,
  startOfMonth,
  type DateRange,
  type NaiveDate,
  type Period,
  type PeriodChoice,
} from "../../lib/period.ts";
import {
  cumulativeSpending,
  monthlyTotals,
  spendingByTopCategory,
  topCategoryOf,
  type CumulativePoint,
  type TopCategorySpending,
} from "./shape.ts";

/** How many months the income vs. spending chart shows, ending with the period's last. */
export const CHART_MONTHS = 8;
/** How many transactions Recent lists. */
export const RECENT_COUNT = 7;

export type MonthTotals = MonthlyTotals & { inPeriod: boolean };

export type Overview = {
  /** The period asked for, or else the one it starts on (see `loadOverview`). */
  choice: PeriodChoice;
  period: Period;
  /** The display currency the overview is in: the one asked for, or else the most used. */
  currency: string;
  /** Every display currency with an overview, the most used first. */
  currencies: string[];
  /** Unix seconds. */
  lastImport: number | null;
  summary: PeriodSummary;
  /** Spending in `period.previous`, if it has one. */
  previousSpent: number | null;
  cumulative: CumulativePoint[];
  categories: TopCategorySpending[];
  /** The top-level category a category is in, or itself. */
  topCategoryOf: (category: string) => string;
  accounts: AccountActivity[];
  months: MonthTotals[];
  recent: RecentTransaction[];
};

// The queries' columns match their row types, and the schema guarantees
// their types.
const rowsOf = <T>(rows: Record<string, unknown>[]) => rows as T[];

/**
 * The currency an overview asked to be in `currency` is in: that one if it
 * has an overview, or else the most used. Undefined without any.
 */
export function overviewCurrency(currency: string | null, currencies: readonly string[]) {
  return currency !== null && currencies.includes(currency) ? currency : currencies[0];
}

/**
 * The periods the overview starts on, the first with any transactions;
 * without, it starts on all of them.
 */
const STARTING_PRESETS = ["this-month", "last-month"] as const;

/** The period the overview starts on, on `today` (see STARTING_PRESETS). */
async function startingChoice(database: Database, today: NaiveDate): Promise<PeriodChoice> {
  const found = await Promise.all(
    STARTING_PRESETS.map(async (kind) => {
      // Neither depends on when the transactions start and end.
      const { from, to } = resolvePeriod({ kind }, today, { first: null, last: null });
      const [row] = rowsOf<TransactionsFound>(
        await database.query(HAS_TRANSACTIONS, { $from: from, $to: to }),
      );
      return row!.found === 1;
    }),
  );
  return { kind: STARTING_PRESETS.find((_, i) => found[i]) ?? "all" };
}

/**
 * Everything the overview shows for `choice`, on `today`, in `currency`.
 * Without a choice, it's for the period it starts on: this month, or else
 * last month, the first with any transactions, or else all time. Without a
 * currency, or when it has no overview (any more), it's in the most used.
 * Null when there are no transactions at all.
 */
export async function loadOverview(
  database: Database,
  choice: PeriodChoice | null,
  currency: string | null,
  today: NaiveDate,
): Promise<Overview | null> {
  const [[meta], currencies, chosen] = await Promise.all([
    database.query(GET_OVERVIEW_META).then(rowsOf<OverviewMeta>),
    database
      .query(LIST_CURRENCIES)
      .then((rows) => rowsOf<CurrencyUse>(rows).map(({ currency }) => currency)),
    choice ?? startingChoice(database, today),
  ]);
  const display = overviewCurrency(currency, currencies);
  if (!meta || display === undefined) return null;

  const period = resolvePeriod(chosen, today, { first: meta.first_date, last: meta.last_date });
  const binds = ({ from, to }: DateRange) => ({ $display: display, $from: from, $to: to });
  const months = monthsEnding(period.to, CHART_MONTHS);

  const [summary, previous, daily, spending, parents, accounts, monthly, recent] =
    await Promise.all([
      database.query(GET_PERIOD_SUMMARY, binds(period)).then(rowsOf<PeriodSummary>),
      period.previous &&
        database.query(GET_PERIOD_SUMMARY, binds(period.previous)).then(rowsOf<PeriodSummary>),
      database.query(LIST_DAILY_SPENDING, binds(period)).then(rowsOf<DailySpending>),
      database.query(LIST_CATEGORY_SPENDING, binds(period)).then(rowsOf<CategorySpending>),
      database.query(LIST_CATEGORY_PARENTS).then(rowsOf<CategoryParent>),
      database
        .query(LIST_ACCOUNT_ACTIVITY, { $from: period.from, $to: period.to })
        .then(rowsOf<AccountActivity>),
      database
        .query(
          LIST_MONTHLY_TOTALS,
          binds({ from: `${months[0]}-01`, to: endOfMonth(`${months.at(-1)}-01`) }),
        )
        .then(rowsOf<MonthlyTotals>),
      database
        .query(LIST_RECENT_TRANSACTIONS, {
          $display: display,
          $from: period.from,
          $to: period.to,
          $limit: RECENT_COUNT,
        })
        .then(rowsOf<RecentTransaction>),
    ]);

  const periodMonths = { from: startOfMonth(period.from), to: period.to };
  return {
    choice: chosen,
    period,
    currency: display,
    currencies,
    lastImport: meta.last_import,
    summary: summary[0]!,
    previousSpent: previous?.[0]?.spent ?? null,
    cumulative: cumulativeSpending(daily, period, today),
    categories: spendingByTopCategory(spending, parents),
    topCategoryOf: topCategoryOf(parents),
    accounts,
    months: monthlyTotals(monthly, months).map((totals) => ({
      ...totals,
      inPeriod:
        `${totals.month}-01` >= periodMonths.from && `${totals.month}-01` <= periodMonths.to,
    })),
    recent,
  };
}

/** `loadOverview` as a query: read again after each change to the database. */
export function overviewQuery(
  database: Database,
  choice: PeriodChoice | null,
  currency: string | null,
  today: NaiveDate,
) {
  return queryOptions({
    queryKey: [...databaseKey(database), "overview", choice, currency, today],
    queryFn: async ({ client }) => {
      const overview = await loadOverview(database, choice, currency, today);
      // The period it started on's overview too, there for the page as it
      // keeps that period (see OverviewPage).
      if (choice === null && overview !== null)
        client.setQueryData(
          overviewQuery(database, overview.choice, currency, today).queryKey,
          overview,
        );
      return overview;
    },
  });
}
