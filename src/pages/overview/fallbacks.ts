/**
 * The amounts the exchange rates give the transactions that have none
 * stored in their overview's currency, for the overview's queries to count
 * them through (see `$fallbacks` in the queries).
 */
import { dayOf } from "../../../currency/chunks.ts";
import type { UnconvertedTransaction } from "../../db/queries/overview.ts";
import { fallbackUnits } from "../../lib/rates/fallback.ts";
import type { Amount } from "../../lib/money.ts";
import { chunksFor, type ChunkRef, type Rates } from "../../lib/rates/rates.ts";

/** A transaction's id, and its amount in its overview's currency, in that one's stored_decimals. */
export type Fallback = [id: string, amount: number];

const conversionsOf = (transaction: UnconvertedTransaction) =>
  JSON.parse(transaction.conversions) as Record<string, Amount>;

/** The chunks that hold the rates `fallbacksFor` could read for the transactions. */
export function fallbackChunks(transactions: readonly UnconvertedTransaction[]): ChunkRef[] {
  return chunksFor(
    transactions.map((transaction) => ({
      naive_date: transaction.naive_date,
      currency: transaction.currency,
      display: transaction.display,
      conversions: conversionsOf(transaction),
    })),
    ({ display }) => display,
  );
}

/**
 * Each transaction's amount in the currency its account displays in, by the
 * rates of its day (see `fallbackUnits`), rounded to what the currency
 * stores. Those the rates can't give one are left out.
 */
export function fallbacksFor(
  transactions: readonly UnconvertedTransaction[],
  rates: Rates,
): Fallback[] {
  const fallbacks: Fallback[] = [];
  for (const transaction of transactions) {
    const day = dayOf(transaction.naive_date);
    if (day === undefined) continue;
    const units = fallbackUnits(
      rates,
      { ...transaction, conversions: conversionsOf(transaction) },
      day,
      transaction.display,
      transaction.display_decimals,
    );
    if (units !== undefined) fallbacks.push([transaction.id, units]);
  }
  return fallbacks;
}
