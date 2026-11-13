/**
 * The exchange rates that are loaded, and a currency's rate among them. A
 * currency or a day without any here has no rate: whether there is none
 * anywhere, it couldn't be fetched or just hasn't been yet is all the same
 * to whoever asks, who does without.
 */
import { dayOf, position } from "../../../currency/chunks.ts";
import { rateAt } from "./reader.ts";

/** What every rate is to: it has no chunks, and its own rate is 1. */
export const EURO = "EUR";

/** The chunks loaded, each filled (see `fill`), by currency and then key. */
export type Rates = ReadonlyMap<string, ReadonlyMap<number, Float64Array>>;

/** A currency's chunk of a key: what holds its rates of the key's days. */
export type ChunkRef = { currency: string; key: number };

/**
 * The rate of a currency in force on a day, the units of it one euro bought,
 * if `rates` has one: the day's own, or the last before it.
 */
export function rateOf(rates: Rates, currency: string, day: number) {
  if (!Number.isInteger(day)) return undefined;
  if (currency === EURO) return 1;
  const { key, index } = position(day);
  const filled = rates.get(currency)?.get(key);
  if (filled === undefined) return undefined;
  const rate = rateAt(filled, index);
  return Number.isNaN(rate) ? undefined : rate;
}

/**
 * The chunks that hold the rates the transactions could need, each once: for
 * every transaction, on its day, those of its own currency, of each currency
 * it has a conversion to, and of the one its account displays in, which
 * `displayOf` tells (nothing for one that has none). A transaction whose date
 * isn't one needs none.
 */
export function chunksFor<
  Transaction extends {
    naive_date: string;
    currency: string;
    conversions: Readonly<Record<string, unknown>>;
  },
>(
  transactions: readonly Transaction[],
  displayOf: (transaction: Transaction) => string | null | undefined,
): ChunkRef[] {
  /** The currencies wanted of each key. */
  const wanted = new Map<number, Set<string>>();
  // Many transactions share a date: its key's currencies are found once.
  const byDate = new Map<string, Set<string> | null>();
  for (const transaction of transactions) {
    let currencies = byDate.get(transaction.naive_date);
    if (currencies === undefined) {
      const day = dayOf(transaction.naive_date);
      if (day === undefined) currencies = null;
      else {
        const { key } = position(day);
        currencies = wanted.get(key) ?? new Set();
        wanted.set(key, currencies);
      }
      byDate.set(transaction.naive_date, currencies);
    }
    if (currencies === null) continue;
    currencies.add(transaction.currency);
    for (const currency in transaction.conversions) currencies.add(currency);
    const display = displayOf(transaction);
    if (display != null) currencies.add(display);
  }
  return [...wanted].flatMap(([key, currencies]) =>
    [...currencies].map((currency) => ({ currency, key })),
  );
}
