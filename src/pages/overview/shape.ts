/**
 * Turns the overview queries' rows into what the cards show.
 */

import type {
  CategoryParent,
  CategorySpending,
  DailySpending,
  MonthlyTotals,
} from "../../db/queries/overview.ts";
import { addDays, type DateRange } from "./period.ts";

export type SubcategorySpending = { name: string; spent: number };

export type TopCategorySpending = {
  /** null for spending without a category. */
  name: string | null;
  spent: number;
  /**
   * Its direct subcategories' spending, each with their own subcategories'
   * included, most first. Spending on the category itself, if it has
   * subcategories too, is listed under its own name.
   */
  subcategories: SubcategorySpending[];
};

/** Every category's ancestors, nearest first. */
export function ancestry(categories: readonly CategoryParent[]) {
  const parents = new Map(categories.map(({ name, parent }) => [name, parent]));
  return (name: string) => {
    const ancestors: string[] = [];
    // The schema prevents loops; the check only stops a corrupted database hanging.
    for (let parent = parents.get(name); parent && !ancestors.includes(parent);) {
      ancestors.push(parent);
      parent = parents.get(parent);
    }
    return ancestors;
  };
}

/** The top-level category `name` is in, or itself. */
export function topCategoryOf(categories: readonly CategoryParent[]) {
  const ancestorsOf = ancestry(categories);
  return (name: string) => ancestorsOf(name).at(-1) ?? name;
}

const bySpentDesc = (a: { spent: number }, b: { spent: number }) => b.spent - a.spent;

/**
 * Spending grouped by top-level category, most first, with spending that
 * has no category last.
 */
export function spendingByTopCategory(
  rows: readonly CategorySpending[],
  categories: readonly CategoryParent[],
): TopCategorySpending[] {
  const ancestorsOf = ancestry(categories);
  const tops = new Map<string | null, { spent: number; subcategories: Map<string, number> }>();

  for (const { category, spent } of rows) {
    // From the top: the top-level category, then the one under it.
    const path = category === null ? [] : [...ancestorsOf(category).reverse(), category];
    const top = path[0] ?? null;
    const entry = tops.get(top) ?? { spent: 0, subcategories: new Map() };
    entry.spent += spent;
    // Spending on the top-level category itself is listed under its own name.
    const sub = path[1] ?? top;
    if (sub !== null) entry.subcategories.set(sub, (entry.subcategories.get(sub) ?? 0) + spent);
    tops.set(top, entry);
  }

  return [...tops]
    .map(([name, { spent, subcategories }]) => {
      const subs = [...subcategories].map(([sub, subSpent]) => ({ name: sub, spent: subSpent }));
      // Only spending on the category itself: nothing to break down.
      const isOnlyItself = subs.length === 1 && subs[0]!.name === name;
      return { name, spent, subcategories: isOnlyItself ? [] : subs.sort(bySpentDesc) };
    })
    .sort((a, b) => (a.name === null ? 1 : b.name === null ? -1 : bySpentDesc(a, b)));
}

export type CumulativePoint = { date: string; total: number };

/**
 * The running total of spending at the end of each day in `range`, after a
 * starting point of 0 the day before it.
 */
export function cumulativeSpending(
  days: readonly DailySpending[],
  range: DateRange,
): CumulativePoint[] {
  const spentOn = new Map(days.map(({ date, spent }) => [date, spent]));
  const points = [{ date: addDays(range.from, -1), total: 0 }];
  let total = 0;
  for (let date = range.from; date <= range.to; date = addDays(date, 1)) {
    total += spentOn.get(date) ?? 0;
    points.push({ date, total });
  }
  return points;
}

/** `months`' totals, with zeros for months without any. */
export function monthlyTotals(
  rows: readonly MonthlyTotals[],
  months: readonly string[],
): MonthlyTotals[] {
  const byMonth = new Map(rows.map((row) => [row.month, row]));
  return months.map((month) => byMonth.get(month) ?? { month, income: 0, spent: 0 });
}

/** Rounded, and 0 when there's nothing to take a share of. */
export function percent(part: number, whole: number) {
  return whole === 0 ? 0 : Math.round((part / whole) * 100);
}
