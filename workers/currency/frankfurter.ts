/**
 * Frankfurter's rates, as the currency worker's assets take them (see
 * format.ts): its daily blend of every currency it has, to the euro.
 */
import { dateOf, dayOf } from "./chunks.ts";
import { type Rate } from "./format.ts";

const FRANKFURTER = "https://api.frankfurter.dev/v2";

/** The currency the rates are of one of. It has no chunks: its rate is always 1. */
export const BASE = "EUR";

/** Frankfurter didn't answer with rates. */
export class FrankfurterError extends Error {
  status: number;
  /** The seconds it asked to be left alone for, when it did. */
  retryAfter: number | undefined;

  constructor(status: number, retryAfter: number | undefined) {
    super(`Reading the rates: ${status}`);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export type Parsed = {
  rates: Rate[];
  /** The rows that weren't a rate to write, as they came. */
  skipped: unknown[];
};

/** A row of Frankfurter's as a rate, or nothing if it isn't one. */
function parseRate(row: unknown): Rate | undefined {
  if (typeof row !== "object" || row === null) return undefined;
  const { date, quote, rate } = row as Record<string, unknown>;
  // A code is part of its chunks' paths.
  if (typeof quote !== "string" || !/^[A-Z0-9]+$/.test(quote)) return undefined;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return undefined;
  const day = typeof date === "string" ? dayOf(date) : undefined;
  return day === undefined ? undefined : { day, quote, rate };
}

/**
 * The rates to write among what Frankfurter answered with, when asked for
 * the days `from` to `to`. A row that isn't one is left out, so that it
 * doesn't keep every other currency's rates from being written. Throws when
 * the answer isn't a list of rows, or has no rate at all.
 *
 * A rate of a day before `from` is nothing wrong: for a currency without a
 * rate on `from`, Frankfurter gives the last it had before. It is left out
 * without being called skipped, as whoever asked for the days before has it.
 */
export function parseRates(body: unknown, from: number, to: number): Parsed {
  if (!Array.isArray(body)) throw new Error("Frankfurter's rates aren't a list");
  const rates: Rate[] = [];
  const skipped: unknown[] = [];
  for (const row of body) {
    const rate = parseRate(row);
    if (rate === undefined || rate.day > to) skipped.push(row);
    // The base's rate to itself, were it listed, is nothing to store.
    else if (rate.day >= from && rate.quote !== BASE) rates.push(rate);
  }
  if (rates.length === 0) throw new Error("Frankfurter's rates have none to write");
  return { rates, skipped };
}

/**
 * Frankfurter's rates of the days `from` to `to`. Throws a
 * `FrankfurterError` when it doesn't answer with any.
 */
export async function fetchRates(from: number, to: number): Promise<Parsed> {
  const response = await fetch(
    `${FRANKFURTER}/rates?from=${dateOf(from)}&to=${dateOf(to)}&base=${BASE}`,
  );
  if (!response.ok) {
    const retryAfter = Number(response.headers.get("Retry-After") ?? NaN);
    throw new FrankfurterError(
      response.status,
      Number.isFinite(retryAfter) ? retryAfter : undefined,
    );
  }
  return parseRates(await response.json(), from, to);
}
