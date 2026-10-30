import { describe, expect, it } from "vitest";
import type { TransactionRow } from "../../db/queries/transactions.ts";
import {
  EMPTY_SEARCH,
  findMatches,
  matchesIn,
  matchFinder,
  matchNumber,
  nextMatch,
  searchPattern,
  type SearchQuery,
} from "./search.ts";

const DATE = 0;
const COUNTERPARTY = 2;
const CATEGORY = 3;
const AMOUNT = 4;
const REMARKS = 5;
const COLUMN_COUNT = 6;

const row = (overrides: Partial<TransactionRow> = {}): TransactionRow => ({
  id: "t1",
  naive_date: "2026-10-09",
  account_name: "Everyday Checking",
  counterparty: "Corner Market",
  category: "Groceries",
  amount: -123_450,
  decimals: 2,
  currency: "USD",
  remarks: null,
  transfer_account: null,
  duplicate_of: null,
  ...overrides,
});

/** How a search looks for its text: as typed and in any case, unless said. */
type SearchOptions = Partial<Omit<SearchQuery, "text">>;

/** The pattern a search for `text` searches with. */
function patternFor(text: string, options: SearchOptions = {}) {
  const pattern = searchPattern({ ...EMPTY_SEARCH, ...options, text });
  if (!pattern?.ok) throw new Error(`no pattern for ${text}`);
  return pattern.value;
}

/** The cells a search for `text` finds something in, as rows and columns. */
const foundIn = (rows: TransactionRow[], text: string, options: SearchOptions = {}) =>
  findMatches(rows, patternFor(text, options)).map((index) => ({
    row: Math.floor(index / COLUMN_COUNT),
    column: index % COLUMN_COUNT,
  }));

/** Where a search for `text` finds it in `cell`. */
const found = (text: string, cell: string, options: SearchOptions = {}) =>
  matchesIn(patternFor(text, options), cell);

const REGEX = { regex: true };

describe("searchPattern", () => {
  it("searches for nothing without text", () => {
    expect(searchPattern(EMPTY_SEARCH)).toBeNull();
    expect(searchPattern({ text: "", regex: true, matchCase: true })).toBeNull();
  });

  it("says why a regular expression can't be one", () => {
    expect(searchPattern({ text: "(", regex: true, matchCase: false })).toEqual({
      ok: false,
      error: expect.any(String),
    });
  });

  it("takes text that would be an invalid regular expression as it is", () => {
    expect(found("(", "Fee (late)")).toEqual([{ start: 4, end: 5 }]);
  });
});

describe("matchesIn", () => {
  it("finds every match, in order", () => {
    expect(found("an", "Banana")).toEqual([
      { start: 1, end: 3 },
      { start: 3, end: 5 },
    ]);
  });

  it("ignores case", () => {
    expect(found("corner", "Corner Market")).toEqual([{ start: 0, end: 6 }]);
    expect(found("CORNER", "Corner Market")).toEqual([{ start: 0, end: 6 }]);
    expect(found("c.*r", "Corner Market", REGEX)).toEqual([{ start: 0, end: 10 }]);
  });

  it("matches case only while asked to", () => {
    const matchCase = { matchCase: true };
    expect(found("corner", "Corner Market", matchCase)).toEqual([]);
    expect(found("Corner", "Corner Market", matchCase)).toEqual([{ start: 0, end: 6 }]);
    expect(found("M.*t", "Corner Market", { ...REGEX, ...matchCase })).toEqual([
      { start: 7, end: 13 },
    ]);
    expect(found("m.*t", "Corner Market", { ...REGEX, ...matchCase })).toEqual([]);
  });

  it("takes text's special characters as they are", () => {
    expect(found("$1.5", "$1.50")).toEqual([{ start: 0, end: 4 }]);
    expect(found("1.5", "125")).toEqual([]);
  });

  it("finds a regular expression's matches", () => {
    expect(found("\\d+", "Shop 12, aisle 3", REGEX)).toEqual([
      { start: 5, end: 7 },
      { start: 15, end: 16 },
    ]);
  });

  it("finds nothing where nothing matches", () => {
    expect(found("Café", "Corner Market")).toEqual([]);
  });

  it("skips matches of nothing", () => {
    expect(found("^", "Corner Market", REGEX)).toEqual([]);
    expect(found("a*", "Bar", REGEX)).toEqual([{ start: 1, end: 2 }]);
  });

  it("matches whole characters, never half of one", () => {
    expect(found(".", "🍎", REGEX)).toEqual([{ start: 0, end: 2 }]);
  });
});

describe("findMatches", () => {
  it("finds the cells, row by row and left to right in each", () => {
    const rows = [
      row({ remarks: "market run" }),
      row({ id: "t2", counterparty: "Shop", category: "Market stall" }),
    ];

    expect(foundIn(rows, "market")).toEqual([
      { row: 0, column: COUNTERPARTY },
      { row: 0, column: REMARKS },
      { row: 1, column: CATEGORY },
    ]);
  });

  it("finds a cell once, however often it's found in it", () => {
    expect(foundIn([row({ counterparty: "Mart Market" })], "mar")).toEqual([
      { row: 0, column: COUNTERPARTY },
    ]);
  });

  it("searches amounts as they're shown", () => {
    expect(foundIn([row()], "$1,234.50")).toEqual([{ row: 0, column: AMOUNT }]);
    expect(foundIn([row()], "1234")).toEqual([]);
  });

  it("searches dates", () => {
    expect(foundIn([row()], "10-09")).toEqual([{ row: 0, column: DATE }]);
  });

  it("doesn't search the notes after the remarks", () => {
    expect(foundIn([row({ transfer_account: "Savings" })], "savings")).toEqual([]);
  });

  it("finds nothing in a cell matched only by nothing", () => {
    expect(foundIn([row()], "^", REGEX)).toEqual([]);
    expect(foundIn([row()], "z*", REGEX)).toEqual([]);
  });

  it("finds what comes after a match of nothing", () => {
    expect(foundIn([row({ counterparty: "Zed" })], "z*", REGEX)).toEqual([
      { row: 0, column: COUNTERPARTY },
    ]);
    // In Unicode mode, past a whole character that takes two.
    expect(foundIn([row({ counterparty: "🍎z" })], "z*", REGEX)).toEqual([
      { row: 0, column: COUNTERPARTY },
    ]);
  });

  it("finds a changed row's text as it is now", () => {
    const before = row();
    expect(foundIn([before], "corner")).toHaveLength(1);

    expect(foundIn([{ ...before, counterparty: "Shop" }], "corner")).toEqual([]);
  });
});

describe("matchFinder", () => {
  it("finds again only for other rows or another pattern", () => {
    const find = matchFinder();
    const rows = [row()];
    const pattern = patternFor("corner");

    const first = find(rows, pattern);

    expect(find(rows, pattern)).toBe(first);
    expect(find([...rows], pattern)).not.toBe(first);
    expect(find(rows, patternFor("corner"))).not.toBe(first);
  });
});

describe("nextMatch", () => {
  // Found in row 0's counterparty, row 1's category and row 3's date.
  const found = [2, COLUMN_COUNT + 3, 3 * COLUMN_COUNT];

  it.each([
    ["the one found", { row: 0, column: 2 }, { row: 1, column: 3 }],
    ["a cell before one found", { row: 1, column: 0 }, { row: 1, column: 3 }],
    ["a cell between rows found in", { row: 2, column: 5 }, { row: 3, column: 0 }],
  ])("goes on from %s to the next", (_, from, next) => {
    expect(nextMatch(found, from, "next")).toEqual(next);
  });

  it.each([
    ["the one found", { row: 1, column: 3 }, { row: 0, column: 2 }],
    ["a cell after one found", { row: 1, column: 5 }, { row: 1, column: 3 }],
    ["a cell between rows found in", { row: 2, column: 0 }, { row: 1, column: 3 }],
  ])("goes back from %s to the previous", (_, from, previous) => {
    expect(nextMatch(found, from, "previous")).toEqual(previous);
  });

  it("goes round from the last to the first, and back", () => {
    expect(nextMatch(found, { row: 3, column: 0 }, "next")).toEqual({ row: 0, column: 2 });
    expect(nextMatch(found, { row: 5, column: 1 }, "next")).toEqual({ row: 0, column: 2 });
    expect(nextMatch(found, { row: 0, column: 2 }, "previous")).toEqual({ row: 3, column: 0 });
    expect(nextMatch(found, { row: 0, column: 0 }, "previous")).toEqual({ row: 3, column: 0 });
  });

  it("stays on a cell found in when inclusive", () => {
    expect(nextMatch(found, { row: 1, column: 3 }, "next", true)).toEqual({ row: 1, column: 3 });
    expect(nextMatch(found, { row: 1, column: 4 }, "next", true)).toEqual({ row: 3, column: 0 });
    expect(nextMatch(found, { row: 1, column: 3 }, "previous", true)).toEqual({
      row: 1,
      column: 3,
    });
  });

  it("goes to the first or the last from no cell", () => {
    expect(nextMatch(found, null, "next")).toEqual({ row: 0, column: 2 });
    expect(nextMatch(found, null, "previous")).toEqual({ row: 3, column: 0 });
  });

  it("goes nowhere when nothing was found", () => {
    expect(nextMatch([], { row: 0, column: 0 }, "next")).toBeNull();
    expect(nextMatch([], null, "previous")).toBeNull();
  });
});

describe("matchNumber", () => {
  const found = [2, 9, 18];

  it("counts a cell found in from 1", () => {
    expect(matchNumber(found, { row: 0, column: 2 })).toBe(1);
    expect(matchNumber(found, { row: 1, column: 3 })).toBe(2);
    expect(matchNumber(found, { row: 3, column: 0 })).toBe(3);
  });

  it("doesn't count a cell it isn't found in", () => {
    expect(matchNumber(found, { row: 1, column: 2 })).toBeNull();
    expect(matchNumber(found, { row: 9, column: 0 })).toBeNull();
    expect(matchNumber([], { row: 0, column: 0 })).toBeNull();
  });
});
