/**
 * How the transactions are ordered and which of them are shown, as the
 * column headers' menus set it, and the rows that makes.
 */

import { compareNewestFirst, type ListedTransaction } from "../../db/queries/transactions.ts";
import { resolvePeriod, type NaiveDate, type PeriodChoice } from "../../lib/period.ts";
import { nameFinder } from "./fields.ts";

export type SortDirection = "ascending" | "descending";

export type SortColumn = "date" | "account" | "counterparty" | "category" | "remarks";

/** The columns, by their headers' menus (see ColumnMenus). */
export type MenuColumn = SortColumn | "amount";

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

/** Whether a transaction is shown, by each filter that hides any. */
function filterFor(view: TransactionsView, names: ViewNames, today: NaiveDate) {
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
  if (!view.showDuplicates) checks.push((row) => row.duplicate_of === null);
  return (row: ListedTransaction) => checks.every((check) => check(row));
}

type Rows = readonly ListedTransaction[];

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

/**
 * The transactions `view` shows, in order, as positions in `rows`. The dates
 * of a period are as of `today`.
 */
export function viewOrder(
  rows: Rows,
  view: TransactionsView,
  names: ViewNames,
  today: NaiveDate,
): number[] {
  const shown = filterFor(view, names, today);
  const order: number[] = [];
  for (let position = 0; position < rows.length; position++)
    if (shown(rows[position]!)) order.push(position);
  order.sort(byRecent(rows));

  const { column, direction } = view.sort;
  const listed = listedNames(names);
  switch (column) {
    case "date":
      // Oldest first is newest first the other way round, the same day's too.
      return direction === "descending" ? order : order.reverse();
    case "account":
      return sortByText(rows, order, listed.account, direction);
    case "counterparty":
      return sortByText(rows, order, (row) => row.counterparty, direction);
    case "category":
      return sortByText(rows, order, listed.category, direction);
    case "remarks":
      return sortByText(rows, order, (row) => row.remarks, direction);
  }
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
