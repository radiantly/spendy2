/**
 * A transaction's amount in the currency its account displays in, for a
 * transaction in another: what the page shows beside its own amount.
 */
import { dayOf } from "../../../currency/chunks.ts";
import {
  conversionTo,
  type AccountCurrency,
  type Currency,
  type ListedTransaction,
} from "../../db/queries/transactions.ts";
import type { Amount } from "../../lib/money.ts";
import { fallbackUnits } from "../../lib/rates/fallback.ts";
import type { Rates } from "../../lib/rates/rates.ts";
import { nameFinder } from "./fields.ts";

/**
 * A transaction's amount in `currency`, the one its account displays in:
 * the conversion stored to it, or without one, what the exchange rates make
 * of the transaction (`estimated`). `amount` is null when it has neither.
 */
export type DisplayAmount = { currency: string; amount: Amount | null; estimated: boolean };

/**
 * Finds the currency a transaction's account displays in: null for an account
 * that displays every transaction in its own, and for one not among
 * `accounts`.
 */
export function displayCurrencies(accounts: readonly AccountCurrency[]) {
  const listed = nameFinder(accounts.map(({ name }) => name));
  const displays = new Map(accounts.map((account) => [account.name, account.display_currency]));
  // A transaction's account name matches the account's ignoring case.
  return (transaction: { account_name: string }) =>
    displays.get(listed(transaction.account_name) ?? "") ?? null;
}

/**
 * Finds a transaction's amount in the currency its account displays in (see
 * `DisplayAmount`), by `rates` where none is stored. Null for a transaction
 * that needs none: one in that currency already, or in an account that
 * displays every transaction in its own.
 */
export function displayAmounts(
  accounts: readonly AccountCurrency[],
  currencies: readonly Currency[],
  rates: Rates,
) {
  const displayOf = displayCurrencies(accounts);
  const decimals = new Map(currencies.map(({ code, stored_decimals }) => [code, stored_decimals]));
  // Many transactions share a date: its day is worked out once.
  const days = new Map<string, number | undefined>();
  const dayOn = (date: string) => {
    if (!days.has(date)) days.set(date, dayOf(date));
    return days.get(date);
  };

  return (transaction: ListedTransaction): DisplayAmount | null => {
    const currency = displayOf(transaction);
    if (currency === null || currency === transaction.currency) return null;
    const stored = conversionTo(transaction, currency);
    if (stored !== undefined) return { currency, amount: stored, estimated: false };

    const day = dayOn(transaction.naive_date);
    const stores = decimals.get(currency);
    const units =
      day === undefined || stores === undefined
        ? undefined
        : fallbackUnits(rates, transaction, day, currency, stores);
    return {
      currency,
      amount: units === undefined ? null : { amount: units, decimals: stores! },
      estimated: units !== undefined,
    };
  };
}
