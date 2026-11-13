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
  LIST_UNCONVERTED,
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
  type UnconvertedTransaction,
} from "../../db/queries/overview.ts";
import { loadedRates } from "../../lib/rates/load.ts";
import type { ChunkRef, Rates } from "../../lib/rates/rates.ts";
import { fallbackChunks, fallbacksFor } from "./fallbacks.ts";
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
  /**
   * The chunks with the exchange rates it could count transactions through:
   * those without an amount stored in their overview's currency (see
   * `loadOverview`). The ones that were loaded, it did.
   */
  rateChunks: ChunkRef[];
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
 *
 * A transaction with no amount stored in its overview's currency counts
 * through the one the exchange rates give it (see `fallbacksFor`), by the
 * rates `ratesOf` has of the chunks it's asked for: it mustn't wait for any,
 * and the overview makes do with the ones it gets.
 */
export async function loadOverview(
  database: Database,
  choice: PeriodChoice | null,
  currency: string | null,
  today: NaiveDate,
  ratesOf: (chunks: ChunkRef[]) => Rates,
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
  const months = monthsEnding(period.to, CHART_MONTHS);
  const charted = { from: `${months[0]}-01`, to: endOfMonth(`${months.at(-1)}-01`) };

  // Every day a query below covers: dates as text order as dates.
  const covered = [period, charted, ...(period.previous ? [period.previous] : [])];
  const unconverted = await database
    .query(LIST_UNCONVERTED, {
      $from: covered.map(({ from }) => from).reduce((a, b) => (a < b ? a : b)),
      $to: covered.map(({ to }) => to).reduce((a, b) => (a > b ? a : b)),
    })
    .then(rowsOf<UnconvertedTransaction>);
  const rateChunks = fallbackChunks(unconverted);
  const $fallbacks = JSON.stringify(fallbacksFor(unconverted, ratesOf(rateChunks)));
  const binds = ({ from, to }: DateRange) => ({
    $display: display,
    $from: from,
    $to: to,
    $fallbacks,
  });

  const [summary, previous, daily, spending, parents, accounts, monthly, recent] =
    await Promise.all([
      database.query(GET_PERIOD_SUMMARY, binds(period)).then(rowsOf<PeriodSummary>),
      period.previous &&
        database.query(GET_PERIOD_SUMMARY, binds(period.previous)).then(rowsOf<PeriodSummary>),
      database.query(LIST_DAILY_SPENDING, binds(period)).then(rowsOf<DailySpending>),
      database.query(LIST_CATEGORY_SPENDING, binds(period)).then(rowsOf<CategorySpending>),
      database.query(LIST_CATEGORY_PARENTS).then(rowsOf<CategoryParent>),
      database
        .query(LIST_ACCOUNT_ACTIVITY, { $from: period.from, $to: period.to, $fallbacks })
        .then(rowsOf<AccountActivity>),
      database.query(LIST_MONTHLY_TOTALS, binds(charted)).then(rowsOf<MonthlyTotals>),
      database
        .query(LIST_RECENT_TRANSACTIONS, { ...binds(period), $limit: RECENT_COUNT })
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
    rateChunks,
  };
}

/**
 * `loadOverview` as a query: read again after each change to the database.
 * It counts transactions through the exchange rates loaded when it's read,
 * without loading any. `ratesLoaded` says which those are (see
 * `useRatesProgress`): given once more have loaded, it's read again with them.
 */
export function overviewQuery(
  database: Database,
  choice: PeriodChoice | null,
  currency: string | null,
  today: NaiveDate,
  ratesLoaded: string,
) {
  return queryOptions({
    queryKey: [...databaseKey(database), "overview", choice, currency, today, ratesLoaded],
    queryFn: async ({ client }) => {
      const overview = await loadOverview(database, choice, currency, today, (chunks) =>
        loadedRates(client, chunks),
      );
      // The period it started on's overview too, there for the page as it
      // keeps that period (see OverviewPage).
      if (choice === null && overview !== null)
        client.setQueryData(
          overviewQuery(database, overview.choice, currency, today, ratesLoaded).queryKey,
          overview,
        );
      return overview;
    },
  });
}
