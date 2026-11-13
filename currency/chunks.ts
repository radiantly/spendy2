/**
 * Where a day's exchange rate is among the currency worker's assets: all that
 * reading the rates takes (see CURRENCY_PLAN.md). The app reads them with
 * this too, so nothing here may need more than the language itself.
 *
 * A currency's rates are in chunks of `CHUNK_DAYS` days, one asset each, at
 * `/CODE-KEY`. A chunk is one little-endian float64 per day from its first:
 * the units of the currency one euro bought that day, as Frankfurter gives
 * it, or NaN for a day without a rate. It ends at its last day with one, so
 * a chunk still being added to is shorter than a full one. The euro has no
 * chunks: its rate is 1.
 */

/** The days in a chunk. */
export const CHUNK_DAYS = 4096;

/** The bytes of a day's rate. */
export const RATE_BYTES = 8;

const MS_PER_DAY = 86_400_000;

/**
 * The day's number: days since 1970-01-01, for a `YYYY-MM-DD`. Undefined for
 * anything else, a date there isn't (a 30th of February) among them.
 */
export function dayOf(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const day = Date.parse(date) / MS_PER_DAY;
  // An engine may take a day past its month's end as one of the next month.
  return Number.isInteger(day) && dateOf(day) === date ? day : undefined;
}

/** The `YYYY-MM-DD` of a day's number. */
export function dateOf(day: number) {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Today's number, in UTC, as Frankfurter's dates are. */
export function today() {
  return Math.floor(Date.now() / MS_PER_DAY);
}

/**
 * The first day there are rates of, and so the first a chunk has one for:
 * the first Frankfurter has rates to the euro for, the euro's own first.
 */
export const FIRST_DAY = dayOf("1999-01-01")!;

/** Where a day's rate is: its chunk's key, and its index among the chunk's days. */
export function position(day: number) {
  const key = Math.floor(day / CHUNK_DAYS);
  return { key, index: day - key * CHUNK_DAYS };
}

export function chunkPath(currency: string, key: number) {
  return `/${currency}-${key}`;
}
