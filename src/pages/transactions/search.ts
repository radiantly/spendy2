/**
 * Searching the transactions' cells for text, or a regular expression: what
 * a search looks for, where it's found in a cell's text, to highlight, and
 * which cells it's found in, to go from one to the next.
 */

import type { TransactionRow } from "../../db/queries/transactions.ts";
import { columns } from "./columns.ts";
import type { ParseResult } from "./fields.ts";
import type { CellPosition } from "./grid.ts";

/**
 * What the action bar's search looks for: `text` as typed, or as a regular
 * expression, in any case, or only in the case typed.
 */
export type SearchQuery = { text: string; regex: boolean; matchCase: boolean };

export const EMPTY_SEARCH: SearchQuery = { text: "", regex: false, matchCase: false };

/** Where something was found in a text: from `start` up to `end`, as string offsets. */
export type TextRange = { start: number; end: number };

/**
 * A pattern that finds `text` as it is, but for digits typed together,
 * which it finds with a comma between any two of them too, as amounts show
 * their thousands: `1234` finds `1,234`.
 */
function literalSource(text: string) {
  // Splitting by a group keeps the runs of digits, at the odd indices.
  return text
    .split(/(\d+)/)
    .map((part, index) => (index % 2 === 0 ? RegExp.escape(part) : [...part].join(",?")))
    .join("");
}

/**
 * The pattern `query` searches with, or why its regular expression can't be
 * one. Null while there's nothing to search for. The pattern is global, to
 * find every match, and in Unicode mode, so a match never splits a character.
 */
export function searchPattern(query: SearchQuery): ParseResult<RegExp> | null {
  if (query.text === "") return null;
  try {
    const source = query.regex ? query.text : literalSource(query.text);
    return { ok: true, value: new RegExp(source, query.matchCase ? "gu" : "giu") };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Where `pattern` matches in `text`, in order. A match of nothing (as `^`
 * or `a*` can be) is skipped: there's nothing there to show.
 */
export function matchesIn(pattern: RegExp, text: string): TextRange[] {
  const ranges: TextRange[] = [];
  for (const match of text.matchAll(pattern))
    if (match[0] !== "") ranges.push({ start: match.index, end: match.index + match[0].length });
  return ranges;
}

/**
 * Whether `matchesIn` would find anything: as it does, but without making
 * the matches, as every cell of every row is asked.
 */
function hasMatch(pattern: RegExp, text: string) {
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match[0] !== "") return true;
    // A match of nothing would be found there again: go on from the next
    // character, a whole one.
    pattern.lastIndex = match.index + (text.codePointAt(match.index)! > 0xffff ? 2 : 1);
  }
  return false;
}

/**
 * Each row's cells' text, as they show it, by the row: worked out once for
 * each, as an edit makes another row of the one it changes.
 */
const shownTexts = new WeakMap<TransactionRow, readonly string[]>();

function shownTextsOf(row: TransactionRow) {
  let texts = shownTexts.get(row);
  if (texts === undefined) {
    texts = columns.map((column) => column.meta!.display(row));
    shownTexts.set(row, texts);
  }
  return texts;
}

/** A cell as one number, in the order cells are searched: row by row, then left to right. */
const indexOf = ({ row, column }: CellPosition) => row * columns.length + column;

const cellAt = (index: number): CellPosition => ({
  row: Math.floor(index / columns.length),
  column: index % columns.length,
});

/**
 * The cells `pattern` finds something in, among the cells of `rows`, in
 * the order they're searched (see `indexOf`). The notes after their text
 * aren't searched.
 */
export function findMatches(rows: readonly TransactionRow[], pattern: RegExp): number[] {
  const found: number[] = [];
  rows.forEach((row, index) => {
    shownTextsOf(row).forEach((text, column) => {
      if (hasMatch(pattern, text)) found.push(indexOf({ row: index, column }));
    });
  });
  return found;
}

/**
 * `findMatches`, but only worked out again for other rows or another
 * pattern: what was found last is kept.
 */
export function matchFinder() {
  let last: { rows: readonly TransactionRow[]; pattern: RegExp; found: number[] } | null = null;
  return (rows: readonly TransactionRow[], pattern: RegExp) => {
    if (last?.rows !== rows || last.pattern !== pattern)
      last = { rows, pattern, found: findMatches(rows, pattern) };
    return last.found;
  };
}

/** How many of `found` come before `index`: where it is, or would be, among them. */
function countBefore(found: readonly number[], index: number) {
  let low = 0;
  let high = found.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (found[middle]! < index) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Which way to go to another match: on, or back. */
export type SearchDirection = "next" | "previous";

/**
 * The cell `direction` of `from` among those `found` (see `findMatches`):
 * the first after it, or the last before it, going round from the last to
 * the first, or back. `from` itself counts too, while `inclusive`. With no
 * cell to go from, the first or the last. Null when nothing was found.
 */
export function nextMatch(
  found: readonly number[],
  from: CellPosition | null,
  direction: SearchDirection,
  inclusive = false,
): CellPosition | null {
  if (found.length === 0) return null;
  if (from === null) return cellAt(direction === "next" ? found[0]! : found.at(-1)!);
  const at = indexOf(from);
  if (direction === "next") {
    const after = countBefore(found, inclusive ? at : at + 1);
    return cellAt(found[after % found.length]!);
  }
  const before = countBefore(found, inclusive ? at + 1 : at) - 1;
  return cellAt(found.at(before)!);
}

/** Which of those `found` (see `findMatches`) `cell` is, counting from 1, if it's one. */
export function matchNumber(found: readonly number[], cell: CellPosition): number | null {
  const index = indexOf(cell);
  const before = countBefore(found, index);
  return found[before] === index ? before + 1 : null;
}
