/**
 * A transaction's amount in a currency it has no conversion stored to,
 * worked out from the exchange rates of its day. A best effort: the rates
 * are one a day, and not the one the transaction was made at.
 */
import type { Amount } from "../money.ts";
import { rateOf, type Rates } from "./rates.ts";
import { convert } from "./reader.ts";

/** What of a transaction its amount in another currency is worked out from. */
export type Convertible = Amount & {
  currency: string;
  /** Its amount in other currencies, as stored, by currency. */
  conversions: Readonly<Record<string, Amount>>;
};

/** An amount as a number of its currency: -12.34 for -1234 with 2 decimals. */
const numberOf = ({ amount, decimals }: Amount) => amount / 10 ** decimals;

/**
 * A transaction's amount in `target`, as a number of it, by the rates of
 * `day`, the transaction's: undefined when they can't tell.
 *
 * Its stored conversions come first: they are what it really came to in
 * some currency, which the rates only guess at for its own. Each one whose
 * currency has a rate is converted, and the largest of them is the amount,
 * whichever way the money went. Only without any is its own amount
 * converted. A conversion stored to `target` itself is for the caller to
 * prefer: here it is one among the others.
 */
export function fallbackAmount(
  rates: Rates,
  transaction: Convertible,
  day: number,
  target: string,
): number | undefined {
  const to = rateOf(rates, target, day);
  if (to === undefined) return undefined;
  let largest: number | undefined;
  for (const currency in transaction.conversions) {
    const from = rateOf(rates, currency, day);
    if (from === undefined) continue;
    const amount = convert(numberOf(transaction.conversions[currency]!), from, to);
    if (largest === undefined || Math.abs(amount) > Math.abs(largest)) largest = amount;
  }
  if (largest !== undefined) return largest;
  const from = rateOf(rates, transaction.currency, day);
  return from === undefined ? undefined : convert(numberOf(transaction), from, to);
}

/**
 * `fallbackAmount` as `target` stores amounts: in units of 10^-`decimals`
 * of it, rounded. Half a unit rounds away from zero, so that money in and
 * money out of the same size round to the same size. Undefined when the rates
 * can't tell, and when what they tell isn't a number to store (a rate of
 * zero makes it infinite).
 */
export function fallbackUnits(
  rates: Rates,
  transaction: Convertible,
  day: number,
  target: string,
  decimals: number,
): number | undefined {
  const amount = fallbackAmount(rates, transaction, day, target);
  if (amount === undefined || !Number.isFinite(amount)) return undefined;
  // Not -0, which JSON can't say.
  return Math.sign(amount) * Math.round(Math.abs(amount) * 10 ** decimals) + 0;
}
