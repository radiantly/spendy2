/**
 * Reads exchange rates out of the chunks `currency.spendy2.com` publishes
 * (the format is in `workers/currency/chunks.ts`). The rates are a fallback, for when
 * a transaction has no conversion stored, and a best effort at one.
 *
 * A chunk has no rate for many of its days: weekends, holidays, the days
 * after its last. The rate in force on such a day is the last before it, so
 * a chunk is filled with them once, and a day's rate is then one read.
 *
 * Nothing here fetches (see load.ts).
 */
import { RATE_BYTES } from "../../../workers/currency/chunks.ts";

/** How many whole rates a chunk has: its days. */
const daysOf = (chunk: ArrayBuffer) => Math.floor(chunk.byteLength / RATE_BYTES);

/** The last rate a chunk has: NaN when it has none. */
export function lastRate(chunk: ArrayBuffer) {
  const view = new DataView(chunk);
  for (let index = daysOf(chunk) - 1; index >= 0; index--) {
    const rate = view.getFloat64(index * RATE_BYTES, true);
    if (!Number.isNaN(rate)) return rate;
  }
  return NaN;
}

/** Whether a chunk's first day has no rate, so that its rate is of a day before the chunk. */
export function startsWithout(chunk: ArrayBuffer) {
  return daysOf(chunk) === 0 || Number.isNaN(new DataView(chunk).getFloat64(0, true));
}

/**
 * A chunk's rates, a day each from its first, filled: a day without a rate
 * has the last before it. `before` is the rate in force as the chunk starts,
 * for its days before its first rate: NaN when there was none, which leaves
 * those days NaN. A chunk there isn't (null), or an empty one, is filled as
 * a single day. Read a day's rate out of it with `rateAt`.
 */
export function fill(chunk: ArrayBuffer | null, before: number) {
  const days = chunk === null ? 0 : daysOf(chunk);
  const filled = new Float64Array(Math.max(days, 1));
  filled[0] = before;
  if (chunk === null) return filled;
  const view = new DataView(chunk);
  let rate = before;
  for (let index = 0; index < days; index++) {
    const own = view.getFloat64(index * RATE_BYTES, true);
    if (!Number.isNaN(own)) rate = own;
    filled[index] = rate;
  }
  return filled;
}

/**
 * The rate in force on a day of a filled chunk, by the day's index in the
 * chunk: NaN when there is none. A day after the chunk's last has its last.
 */
export function rateAt(filled: Float64Array, index: number) {
  return filled[Math.min(index, filled.length - 1)]!;
}

/**
 * An amount of one currency in another, from the rate of each: `from` of the
 * amount's currency and `to` of the other, both of the same day. The euro's
 * rate is 1.
 */
export function convert(amount: number, from: number, to: number) {
  // The rates' ratio first: it is exactly 1 between a currency and itself,
  // which leaves the amount as it is. Multiplying first would not always.
  return amount * (to / from);
}
