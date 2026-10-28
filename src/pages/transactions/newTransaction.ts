/**
 * What a row added from the action bar starts as.
 */

import {
  compareNewestFirst,
  type AccountCurrency,
  type ListedTransaction,
} from "../../db/queries/transactions.ts";
import type { NewTransaction } from "../../db/transactions.ts";
import type { NaiveDate } from "../../lib/period.ts";

/** The currency when nothing else gives one. */
const LAST_RESORT_CURRENCY = "USD";

/**
 * A transaction to add beside `beside`: on its day, at its time, in its
 * account and currency. With nothing beside it, it's on `today`, without a
 * time, in the first of `accounts` (there has to be one), in that
 * account's display currency, or the newest of `transactions`', or another
 * account's display currency, or as a last resort, USD.
 *
 * Otherwise it's as blank as a transaction can be: its counterparty is "-",
 * as one can't be empty, its amount 0, and it has no remarks.
 */
export function newTransaction(
  beside: ListedTransaction | null,
  {
    accounts,
    transactions,
    today,
  }: {
    accounts: readonly AccountCurrency[];
    transactions: readonly ListedTransaction[];
    today: NaiveDate;
  },
): NewTransaction {
  const blank = { counterparty: "-", amount: 0, remarks: null };
  if (beside !== null)
    return {
      naive_date: beside.naive_date,
      timestamp: beside.timestamp,
      account_name: beside.account_name,
      currency: beside.currency,
      ...blank,
    };
  const account = accounts[0]!;
  const newest = transactions.reduce<ListedTransaction | null>(
    (newest, row) => (newest === null || compareNewestFirst(row, newest) < 0 ? row : newest),
    null,
  );
  return {
    naive_date: today,
    timestamp: null,
    account_name: account.name,
    currency:
      account.display_currency ??
      newest?.currency ??
      accounts.find(({ display_currency }) => display_currency !== null)?.display_currency ??
      LAST_RESORT_CURRENCY,
    ...blank,
  };
}
