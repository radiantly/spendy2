import { describe, expect, it } from "vitest";
import {
  cumulativeSpending,
  monthlyTotals,
  percent,
  spendingByTopCategory,
  topCategoryOf,
} from "./shape.ts";

const CATEGORIES = [
  { name: "Food", parent: null },
  { name: "Groceries", parent: "Food" },
  { name: "Dining out", parent: "Food" },
  { name: "Coffee", parent: "Dining out" },
  { name: "Health", parent: null },
  { name: "Housing", parent: null },
  { name: "Rent", parent: "Housing" },
];

describe("spendingByTopCategory", () => {
  it("adds subcategories up into their top-level category, most first", () => {
    expect(
      spendingByTopCategory(
        [
          { category: "Groceries", spent: 30 },
          { category: "Dining out", spent: 20 },
          { category: "Rent", spent: 100 },
        ],
        CATEGORIES,
      ),
    ).toEqual([
      { name: "Housing", spent: 100, subcategories: [{ name: "Rent", spent: 100 }] },
      {
        name: "Food",
        spent: 50,
        subcategories: [
          { name: "Groceries", spent: 30 },
          { name: "Dining out", spent: 20 },
        ],
      },
    ]);
  });

  it("adds deeper subcategories into the one under the top level", () => {
    expect(
      spendingByTopCategory(
        [
          { category: "Coffee", spent: 5 },
          { category: "Dining out", spent: 20 },
          { category: "Groceries", spent: 10 },
        ],
        CATEGORIES,
      )[0]!.subcategories,
    ).toEqual([
      { name: "Dining out", spent: 25 },
      { name: "Groceries", spent: 10 },
    ]);
  });

  it("lists spending on a top-level category itself under its own name", () => {
    expect(
      spendingByTopCategory(
        [
          { category: "Food", spent: 7 },
          { category: "Groceries", spent: 30 },
        ],
        CATEGORIES,
      ),
    ).toEqual([
      {
        name: "Food",
        spent: 37,
        subcategories: [
          { name: "Groceries", spent: 30 },
          { name: "Food", spent: 7 },
        ],
      },
    ]);
  });

  it("doesn't break down a category with only spending on itself", () => {
    expect(spendingByTopCategory([{ category: "Health", spent: 9 }], CATEGORIES)).toEqual([
      { name: "Health", spent: 9, subcategories: [] },
    ]);
  });

  it("puts spending without a category last, however big", () => {
    expect(
      spendingByTopCategory(
        [
          { category: null, spent: 500 },
          { category: "Health", spent: 9 },
        ],
        CATEGORIES,
      ).map(({ name }) => name),
    ).toEqual(["Health", null]);
  });

  it("treats a category it doesn't know as top-level", () => {
    expect(spendingByTopCategory([{ category: "Mystery", spent: 3 }], CATEGORIES)).toEqual([
      { name: "Mystery", spent: 3, subcategories: [] },
    ]);
  });

  it("doesn't hang on a loop of parents", () => {
    const loop = [
      { name: "A", parent: "B" },
      { name: "B", parent: "A" },
    ];
    expect(spendingByTopCategory([{ category: "A", spent: 1 }], loop)).toHaveLength(1);
  });
});

describe("topCategoryOf", () => {
  it("finds the top level at any depth", () => {
    const top = topCategoryOf(CATEGORIES);
    expect(top("Coffee")).toBe("Food");
    expect(top("Food")).toBe("Food");
    expect(top("Unknown")).toBe("Unknown");
  });
});

describe("cumulativeSpending", () => {
  it("adds up every day of the range, from 0 the day before", () => {
    expect(
      cumulativeSpending(
        [
          { date: "2026-10-01", spent: 10 },
          { date: "2026-10-03", spent: 5 },
        ],
        { from: "2026-10-01", to: "2026-10-04" },
      ),
    ).toEqual([
      { date: "2026-09-30", total: 0 },
      { date: "2026-10-01", total: 10 },
      { date: "2026-10-02", total: 10 },
      { date: "2026-10-03", total: 15 },
      { date: "2026-10-04", total: 15 },
    ]);
  });
});

describe("monthlyTotals", () => {
  it("fills months without any with zeros", () => {
    expect(
      monthlyTotals([{ month: "2026-09", income: 5, spent: 3 }], ["2026-08", "2026-09"]),
    ).toEqual([
      { month: "2026-08", income: 0, spent: 0 },
      { month: "2026-09", income: 5, spent: 3 },
    ]);
  });
});

describe("percent", () => {
  it("rounds, and is 0 of nothing", () => {
    expect(percent(1, 3)).toBe(33);
    expect(percent(5, 0)).toBe(0);
  });
});
