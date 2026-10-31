/**
 * What the transactions' loader shows (see TransactionsLoader.tsx): rows of
 * made-up transactions, one more each step, whose cells change now and
 * then, some to "Loading", each going through a few versions in turn.
 * Their names are random letters, so they're no one's. All of it follows
 * from how many steps have passed, so a loader shown afresh after as long
 * shows the same.
 */

import type { TransactionRow } from "../../db/queries/transactions.ts";
import { addDays, today } from "../../lib/period.ts";
import { columns } from "./columns.ts";

/** How long a step is (ms): about every other frame. */
export const STEP = 33;

/** The most rows the loader shows: it adds one a step until it's shown them all. */
export const MAX_ROWS = 100;

/** What a cell says in place of data now and then. */
export const LOADING = "Loading";

/** How often a cell says "Loading" rather than showing data: 1 time in this many. */
const LOADING_ONE_IN = 5;

/**
 * How long a cell shows the same thing (steps): its own time, somewhere in
 * this range, so they change at different times.
 */
const SHORTEST_SHOWING = 60;
const LONGEST_SHOWING = 240;

const CURRENCIES = ["USD", "USD", "USD", "EUR", "SGD"];

/** A number from 32 bits, mixed so that close inputs give far-apart results. */
function mix(value: number) {
  let hash = Math.imul(value ^ (value >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

/** What each source of numbers is for (see randomFrom), so no two give the same numbers. */
const TIMING = 1;
const SAYS_LOADING = 2;
const TRANSACTION = 3;

/** A source of numbers in [0, 1), the same each time for the same `parts`. */
function randomFrom(...parts: number[]) {
  let state = parts.reduce((hash, part) => mix(hash ^ part), 0x9e3779b9);
  return () => {
    state = mix(state + 0x6d2b79f5);
    return state / 2 ** 32;
  };
}

const pick = <T>(random: () => number, options: readonly T[]) =>
  options[Math.floor(random() * options.length)]!;

/** A whole number from `least` to `most`. */
const between = (random: () => number, least: number, most: number) =>
  least + Math.floor(random() * (most - least + 1));

/**
 * Made-up words of random letters, not real ones, `words` of them, each
 * `letters` long, the first capitalized, or each with `titled`.
 */
function madeUpWords(
  random: () => number,
  words: [number, number],
  letters: [number, number],
  titled = false,
) {
  return Array.from({ length: between(random, ...words) }, (_, at) => {
    const word = Array.from({ length: between(random, ...letters) }, () =>
      String.fromCharCode(97 + Math.floor(random() * 26)),
    ).join("");
    return at === 0 || titled ? word[0]!.toUpperCase() + word.slice(1) : word;
  }).join(" ");
}

/**
 * A made-up transaction: its names random letters, its date and amount as
 * real ones might be.
 */
function madeUpRow(random: () => number): TransactionRow {
  // Mostly money out, now and then in.
  const cents = 1 + Math.floor(random() * 200_000);
  return {
    id: "",
    naive_date: addDays(today(), -Math.floor(random() * 120)),
    account_name: madeUpWords(random, [1, 2], [4, 8], true),
    counterparty: madeUpWords(random, [1, 3], [3, 9], true),
    // Now and then none, as some aren't categorized.
    category: random() < 0.15 ? null : madeUpWords(random, [1, 1], [5, 10]),
    amount: random() < 0.15 ? cents : -cents,
    decimals: 2,
    currency: pick(random, CURRENCIES),
    // Most have none.
    remarks: random() < 0.5 ? null : madeUpWords(random, [2, 4], [2, 7]),
    transfer_account: null,
    duplicate_of: null,
  };
}

/** How many rows the loader shows after `steps`. */
export function loaderRowCount(steps: number) {
  return Math.min(MAX_ROWS, Math.max(0, steps) + 1);
}

/** How many versions each cell has, shown in turn, over and over. */
const VERSIONS = 4;

/**
 * When the loader's cell in `column` (as in columns.ts) of `row` changes:
 * it shows each version for `showing` steps, its own while, and had shown
 * its first for `shown` of them when the loader began, so they don't all
 * change together.
 */
function cellTiming(row: number, column: number) {
  const timing = randomFrom(TIMING, row, column);
  const showing = SHORTEST_SHOWING + Math.floor(timing() * (LONGEST_SHOWING - SHORTEST_SHOWING));
  return { showing, shown: timing() * showing };
}

/**
 * Which version the loader's cell in `column` of `row` shows after `steps`.
 * With `steps` 0, the first.
 */
export function cellVersion(row: number, column: number, steps: number) {
  const { showing, shown } = cellTiming(row, column);
  return Math.floor((Math.max(0, steps) + shown) / showing) % VERSIONS;
}

/** The made-up transactions shown, by row and version (see madeUpTransaction). */
const madeUp = new Map<number, TransactionRow>();

/**
 * The made-up transaction the loader's `row` shows in its `version`: each
 * of the row's cells shows its column of it. Made up the first time it's
 * shown, then kept, as the loader shows each again and again.
 */
function madeUpTransaction(row: number, version: number) {
  const key = row * VERSIONS + version;
  let transaction = madeUp.get(key);
  if (transaction === undefined) {
    transaction = madeUpRow(randomFrom(TRANSACTION, row, version));
    madeUp.set(key, transaction);
  }
  return transaction;
}

/**
 * What the cell in `column` of the loader's `row` says in its `version`
 * (see cellVersion): made-up data as the column shows it, or "Loading".
 */
export function cellText(row: number, column: number, version: number) {
  if (randomFrom(SAYS_LOADING, row, column, version)() * LOADING_ONE_IN < 1) return LOADING;
  return columns[column]!.meta!.display(madeUpTransaction(row, version));
}
