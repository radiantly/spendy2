/**
 * How the transactions are ordered and which of them are shown, as the
 * column headers' menus set it, and the rows that makes.
 */

import { compareNewestFirst, type ListedTransaction } from "../../db/queries/transactions.ts";
import { dayOf } from "../../../currency/chunks.ts";
import { resolvePeriod, type NaiveDate, type PeriodChoice } from "../../lib/period.ts";
import { fallbackAmount } from "../../lib/rates/fallback.ts";
import { EURO, type Rates } from "../../lib/rates/rates.ts";
import { nameFinder } from "./fields.ts";

export type SortDirection = "ascending" | "descending";

export type SortColumn = "date" | "account" | "counterparty" | "category" | "amount" | "remarks";

/** The columns, by their headers' menus (see ColumnMenus): each one sorts. */
export type MenuColumn = SortColumn;

/** One column at a time sorts the transactions. */
export type Sort = { column: SortColumn; direction: SortDirection };

/** The direction `column` sorts in, if it's the one that does. */
export function sortedBy(sort: Sort, column: MenuColumn) {
  return sort.column === column ? sort.direction : undefined;
}

/** Which amounts are shown: all of them, money in (above zero), or money out (below). */
export type Flow = "all" | "in" | "out";

/**
 * Filters by a list of values keep the values unchecked, rather than those
 * checked, so a value that's new (an account added later, say) shows until
 * it's unchecked too.
 */
export type TransactionsView = {
  sort: Sort;
  /** "all" shows every date. */
  dates: PeriodChoice;
  /** By name, as the accounts are listed. */
  hiddenAccounts: ReadonlySet<string>;
  /**
   * By name, as the categories are listed: a category's hides the
   * transactions set to it, not to its subcategories. null hides those
   * without a category.
   */
  hiddenCategories: ReadonlySet<string | null>;
  flow: Flow;
  hiddenCurrencies: ReadonlySet<string>;
  /** Whether those marked as a duplicate of another (see marks.ts) are shown. */
  showDuplicates: boolean;
};

export const DEFAULT_VIEW: TransactionsView = {
  sort: { column: "date", direction: "descending" },
  dates: { kind: "all" },
  hiddenAccounts: new Set(),
  hiddenCategories: new Set(),
  flow: "all",
  hiddenCurrencies: new Set(),
  showDuplicates: false,
};

/** The names the view's filters are by. */
export type ViewNames = {
  accounts: readonly string[];
  categories: readonly string[];
};

/**
 * Account and category names as they're listed. A transaction's can be
 * spelled in another case (they're `COLLATE NOCASE`); it keeps its own if
 * it isn't listed, which the schema doesn't allow.
 */
function listedNames(names: ViewNames) {
  const account = nameFinder(names.accounts);
  const category = nameFinder(names.categories);
  return {
    account: (row: ListedTransaction) => account(row.account_name) ?? row.account_name,
    category: (row: ListedTransaction) =>
      row.category === null ? null : (category(row.category) ?? row.category),
  };
}

/**
 * The transactions a view hides, as positions in its rows. Those `filtered`
 * out by the columns' filters keep their numbers, so the numbers shown skip
 * theirs. The `uncounted`, duplicates while those aren't shown, take none.
 */
export type Hidden = {
  filtered: ReadonlySet<number>;
  uncounted: ReadonlySet<number>;
};

/** How `view` hides a transaction (see `Hidden`), or null if it shows it. */
function hiderFor(view: TransactionsView, names: ViewNames, today: NaiveDate) {
  const listed = listedNames(names);
  const checks: ((row: ListedTransaction) => boolean)[] = [];
  if (view.dates.kind !== "all") {
    // Only "all" reads the transactions' first and last dates.
    const { from, to } = resolvePeriod(view.dates, today, { first: null, last: null });
    checks.push((row) => row.naive_date >= from && row.naive_date <= to);
  }
  if (view.hiddenAccounts.size > 0)
    checks.push((row) => !view.hiddenAccounts.has(listed.account(row)));
  if (view.hiddenCategories.size > 0)
    checks.push((row) => !view.hiddenCategories.has(listed.category(row)));
  if (view.flow === "in") checks.push((row) => row.amount > 0);
  if (view.flow === "out") checks.push((row) => row.amount < 0);
  if (view.hiddenCurrencies.size > 0)
    checks.push((row) => !view.hiddenCurrencies.has(row.currency));
  return (row: ListedTransaction): keyof Hidden | null => {
    if (!view.showDuplicates && row.duplicate_of !== null) return "uncounted";
    return checks.every((check) => check(row)) ? null : "filtered";
  };
}

type Rows = readonly ListedTransaction[];

/**
 * `hidden` with those of the rows at `among` (positions in `rows`) that
 * `view` hides. The dates of a period are as of `today`.
 */
export function withHidden(
  hidden: Hidden,
  among: Iterable<number>,
  rows: Rows,
  view: TransactionsView,
  names: ViewNames,
  today: NaiveDate,
): Hidden {
  const hiding = hiderFor(view, names, today);
  const filtered = new Set(hidden.filtered);
  const uncounted = new Set(hidden.uncounted);
  for (const position of among) {
    const how = hiding(rows[position]!);
    if (how === "filtered") filtered.add(position);
    if (how === "uncounted") uncounted.add(position);
  }
  return { filtered, uncounted };
}

/** The transactions `view` hides. The dates of a period are as of `today`. */
export function viewHidden(
  rows: Rows,
  view: TransactionsView,
  names: ViewNames,
  today: NaiveDate,
): Hidden {
  return withHidden(
    { filtered: new Set(), uncounted: new Set() },
    rows.keys(),
    rows,
    view,
    names,
    today,
  );
}

/**
 * The rows shown, in `order` (positions in `rows`), each with its number:
 * its place in the order, from 1, among the rows that are there (not
 * `removed`) and counted (see `Hidden`). So filtering leaves the numbers as
 * they are, skipping the hidden rows', and only sorting gives new ones.
 */
export function shownRows<Row>(
  rows: readonly Row[],
  order: readonly number[],
  hidden: Hidden,
  removed: ReadonlySet<number>,
): { rows: Row[]; numbers: number[] } {
  const shown: { rows: Row[]; numbers: number[] } = { rows: [], numbers: [] };
  let number = 0;
  for (const position of order) {
    if (removed.has(position) || hidden.uncounted.has(position)) continue;
    number++;
    if (hidden.filtered.has(position)) continue;
    shown.rows.push(rows[position]!);
    shown.numbers.push(number);
  }
  return shown;
}

/** Positions in `rows` newest first, as the transactions are listed. */
function byRecent(rows: Rows) {
  return (a: number, b: number) => compareNewestFirst(rows[a]!, rows[b]!);
}

/** Names in alphabetical order for people: ignoring case, and with numbers by value. */
const collator = new Intl.Collator(undefined, { numeric: true });

/**
 * Sorts `order` (positions in `rows`, newest first) by a text column, keeping
 * the transactions with the same text newest first. Transactions without the
 * text (no category, or no remarks) go last either way.
 *
 * A counting sort: each distinct text is ranked once, and the transactions
 * are placed by their text's rank, in the order they come. Comparing the
 * transactions themselves took several times as long.
 */
function sortByText(
  rows: Rows,
  order: readonly number[],
  textOf: (row: ListedTransaction) => string | null,
  direction: SortDirection,
) {
  const textsOf = order.map((position) => textOf(rows[position]!));
  const ranks = new Map<string, number>();
  for (const text of textsOf) if (text !== null) ranks.set(text, 0);
  const sorted = [...ranks.keys()].sort(collator.compare);
  if (direction === "descending") sorted.reverse();
  sorted.forEach((text, rank) => ranks.set(text, rank));
  // Each transaction's text's rank; no text ranks after every text.
  const rankAt = Int32Array.from(textsOf, (text) =>
    text === null ? sorted.length : ranks.get(text)!,
  );
  // Where each rank's transactions start: after all those of the ranks before.
  const starts = new Int32Array(sorted.length + 2);
  for (const rank of rankAt) starts[rank + 1]!++;
  for (let rank = 1; rank < starts.length; rank++) starts[rank]! += starts[rank - 1]!;
  const sortedOrder = new Array<number>(order.length);
  rankAt.forEach((rank, index) => {
    sortedOrder[starts[rank]!++] = order[index]!;
  });
  return sortedOrder;
}

/** How large an amount is, whichever way the money went, as a number of its currency. */
const sizeOf = (row: ListedTransaction) => Math.abs(row.amount) / 10 ** row.decimals;

/**
 * How large a transaction's amount is next to those in other currencies:
 * in euros, by `rates` (see `fallbackAmount`). NaN when they can't tell.
 * Any currency would order them the same, and the euro's rate is always there.
 */
function comparableSizes(rates: Rates) {
  // Many transactions share a date: its day is worked out once.
  const days = new Map<string, number | undefined>();
  return (row: ListedTransaction) => {
    let day = days.get(row.naive_date);
    if (day === undefined && !days.has(row.naive_date))
      days.set(row.naive_date, (day = dayOf(row.naive_date)));
    if (day === undefined) return NaN;
    return Math.abs(fallbackAmount(rates, row, day, EURO) ?? NaN);
  };
}

/**
 * Sorts `order` (positions in `rows`, newest first) by how large the
 * amounts are, across currencies (see `comparableSizes`), keeping the
 * transactions of the same size newest first. Those the rates can't tell the
 * size of go last either way, in the same direction among themselves by
 * their amounts as numbers, whatever their currencies.
 */
function sortByAmount(
  rows: Rows,
  order: readonly number[],
  direction: SortDirection,
  rates: Rates,
) {
  const comparable = comparableSizes(rates);
  // By position in `rows`: the size to sort by, and whether the rates gave it.
  const sizes = new Float64Array(rows.length);
  const rated: number[] = [];
  const unrated: number[] = [];
  for (const position of order) {
    const row = rows[position]!;
    const size = comparable(row);
    const known = !Number.isNaN(size);
    sizes[position] = known ? size : sizeOf(row);
    (known ? rated : unrated).push(position);
  }
  const bySize =
    direction === "ascending"
      ? (a: number, b: number) => sizes[a]! - sizes[b]!
      : (a: number, b: number) => sizes[b]! - sizes[a]!;
  // Stable: the same size stays newest first.
  return [...rated.sort(bySize), ...unrated.sort(bySize)];
}

/**
 * Every transaction, those a view hides too, in the order `sort` puts them,
 * as positions in `rows`. Only sorting by amount reads `rates`, and makes
 * do with the ones there are.
 */
export function sortOrder(rows: Rows, sort: Sort, names: ViewNames, rates: Rates): number[] {
  const order = Array.from(rows.keys());
  order.sort(byRecent(rows));

  const { column, direction } = sort;
  if (column === "amount") return sortByAmount(rows, order, direction, rates);
  const textOf = sortTextOf(column, names);
  // Oldest first is newest first the other way round, the same day's too.
  if (textOf === null) return direction === "descending" ? order : order.reverse();
  return sortByText(rows, order, textOf, direction);
}

/** The text `column` sorts transactions by, or null for the date. */
function sortTextOf(column: Exclude<SortColumn, "amount">, names: ViewNames) {
  const listed = listedNames(names);
  const texts: Record<typeof column, ((row: ListedTransaction) => string | null) | null> = {
    date: null,
    account: listed.account,
    counterparty: (row) => row.counterparty,
    category: listed.category,
    remarks: (row) => row.remarks,
  };
  return texts[column];
}

/** Which of two transactions `sort` puts first, as `sortOrder` does: negative if `a`. */
function compareBy(sort: Sort, names: ViewNames, rates: Rates) {
  const { column, direction } = sort;
  if (column === "amount") return compareByAmount(direction, rates);
  const textOf = sortTextOf(column, names);
  if (textOf === null)
    return direction === "descending"
      ? compareNewestFirst
      : (a: ListedTransaction, b: ListedTransaction) => compareNewestFirst(b, a);
  const sign = direction === "ascending" ? 1 : -1;
  return (a: ListedTransaction, b: ListedTransaction) => {
    const [x, y] = [textOf(a), textOf(b)];
    // Those without the text go last either way (see `sortByText`).
    if (x === null || y === null) return x === y ? compareNewestFirst(a, b) : x === null ? 1 : -1;
    return sign * collator.compare(x, y) || compareNewestFirst(a, b);
  };
}

/** Which of two transactions sorting by amount puts first, as `sortByAmount` does. */
function compareByAmount(direction: SortDirection, rates: Rates) {
  const comparable = comparableSizes(rates);
  const sign = direction === "ascending" ? 1 : -1;
  return (a: ListedTransaction, b: ListedTransaction) => {
    const [x, y] = [comparable(a), comparable(b)];
    const [unratedA, unratedB] = [Number.isNaN(x), Number.isNaN(y)];
    // Those without a size go last either way, by their amounts as numbers.
    if (unratedA !== unratedB) return unratedA ? 1 : -1;
    const difference = unratedA ? sizeOf(a) - sizeOf(b) : x - y;
    return sign * difference || compareNewestFirst(a, b);
  };
}

/**
 * `order` with the rows at `arrived` (positions in `rows`) placed among its
 * rows, where `sort` would put them. The rows already in it keep their
 * order, even where it's no longer the sort's: an edited row stays where it
 * was.
 */
export function withArrived(
  order: readonly number[],
  arrived: readonly number[],
  rows: Rows,
  sort: Sort,
  names: ViewNames,
  rates: Rates,
): number[] {
  const compare = compareBy(sort, names, rates);
  const before = (a: number, b: number) => compare(rows[a]!, rows[b]!) < 0;
  const placing = arrived.toSorted((a, b) => compare(rows[a]!, rows[b]!));
  const placed: number[] = [];
  let next = 0;
  for (const position of order) {
    while (next < placing.length && before(placing[next]!, position)) placed.push(placing[next++]!);
    placed.push(position);
  }
  placed.push(...placing.slice(next));
  return placed;
}

/** What the transactions have that the filters can be set to. */
export type FilterValues = {
  /** Each category some transaction is set to, as listed; null if one has none. */
  categories: ReadonlySet<string | null>;
  /** Alphabetical. */
  currencies: readonly string[];
};

export function filterValues(rows: Rows, names: ViewNames): FilterValues {
  const listed = listedNames(names);
  const categories = new Set<string | null>();
  const currencies = new Set<string>();
  for (const row of rows) {
    categories.add(listed.category(row));
    currencies.add(row.currency);
  }
  return { categories, currencies: [...currencies].sort() };
}
