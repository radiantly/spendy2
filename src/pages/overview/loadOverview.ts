import type { Database } from "../../db/database.ts";
import {
  GET_OVERVIEW_META,
  GET_PERIOD_SUMMARY,
  LIST_ACCOUNT_ACTIVITY,
  LIST_CATEGORY_PARENTS,
  LIST_CATEGORY_SPENDING,
  LIST_DAILY_SPENDING,
  LIST_MONTHLY_TOTALS,
  LIST_RECENT_TRANSACTIONS,
  type AccountActivity,
  type CategoryParent,
  type CategorySpending,
  type DailySpending,
  type MonthlyTotals,
  type OverviewMeta,
  type PeriodSummary,
  type RecentTransaction,
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
} from "./period.ts";
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
  period: Period;
  /** The currency totals are in. */
  currency: string;
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
 * Everything the overview shows for `choice`, on `today`. Null when there
 * are no transactions at all.
 */
export async function loadOverview(
  database: Database,
  choice: PeriodChoice,
  today: NaiveDate,
): Promise<Overview | null> {
  const [meta] = rowsOf<OverviewMeta>(await database.query(GET_OVERVIEW_META));
  if (!meta || meta.base_currency === null) return null;

  const period = resolvePeriod(choice, today, { first: meta.first_date, last: meta.last_date });
  const base = meta.base_currency;
  const binds = ({ from, to }: DateRange) => ({ $base: base, $from: from, $to: to });
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
          $base: base,
          $from: period.from,
          $to: period.to,
          $limit: RECENT_COUNT,
        })
        .then(rowsOf<RecentTransaction>),
    ]);

  const periodMonths = { from: startOfMonth(period.from), to: period.to };
  return {
    period,
    currency: base,
    lastImport: meta.last_import,
    summary: summary[0]!,
    previousSpent: previous?.[0]?.spent ?? null,
    cumulative: cumulativeSpending(daily, period),
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
