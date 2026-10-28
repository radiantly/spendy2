import { describe, expect, it } from "vitest";
import type { AccountCurrency, ListedTransaction } from "../../db/queries/transactions.ts";
import { newTransaction } from "./newTransaction.ts";

const TODAY = "2026-10-28";
const BLANK = { counterparty: "-", amount: 0, remarks: null };

function transaction(overrides: Partial<ListedTransaction> = {}): ListedTransaction {
  return {
    id: "t1",
    naive_date: "2026-10-10",
    timestamp: null,
    sort_key: 1,
    account_name: "Checking",
    counterparty: "Corner Market",
    category: "Groceries",
    amount: -4620,
    decimals: 2,
    currency: "USD",
    remarks: "Weekly",
    transfer_account: null,
    duplicate_of: null,
    conversions: {},
    ...overrides,
  };
}

const account = (name: string, display_currency: string | null): AccountCurrency => ({
  name,
  display_currency,
});

describe("newTransaction", () => {
  it("is on the day of the one it's beside, at its time, in its account and currency", () => {
    const beside = transaction({
      naive_date: "2026-10-05",
      timestamp: 1_791_000_000,
      account_name: "Travel",
      currency: "EUR",
    });

    expect(
      newTransaction(beside, {
        accounts: [account("Checking", "USD")],
        transactions: [beside],
        today: TODAY,
      }),
    ).toEqual({
      naive_date: "2026-10-05",
      timestamp: 1_791_000_000,
      account_name: "Travel",
      currency: "EUR",
      ...BLANK,
    });
  });

  describe("beside none", () => {
    it("is today's, without a time, in the first account and its display currency", () => {
      expect(
        newTransaction(null, {
          accounts: [account("Checking", "SGD"), account("Travel", "EUR")],
          transactions: [transaction({ currency: "USD" })],
          today: TODAY,
        }),
      ).toEqual({
        naive_date: TODAY,
        timestamp: null,
        account_name: "Checking",
        currency: "SGD",
        ...BLANK,
      });
    });

    it("is in the newest transaction's currency when the account has no display currency", () => {
      const older = transaction({ id: "a", naive_date: "2026-10-01", currency: "JPY" });
      const newer = transaction({ id: "b", naive_date: "2026-10-09", currency: "EUR" });

      expect(
        newTransaction(null, {
          accounts: [account("Brokerage", null), account("Checking", "USD")],
          transactions: [older, newer, transaction({ id: "c", naive_date: "2026-10-02" })],
          today: TODAY,
        }).currency,
      ).toBe("EUR");
    });

    it("is in another account's display currency without any transactions", () => {
      expect(
        newTransaction(null, {
          accounts: [
            account("Brokerage", null),
            account("Savings", null),
            account("Travel", "EUR"),
          ],
          transactions: [],
          today: TODAY,
        }).currency,
      ).toBe("EUR");
    });

    it("is in USD as a last resort", () => {
      expect(
        newTransaction(null, {
          accounts: [account("Brokerage", null)],
          transactions: [],
          today: TODAY,
        }).currency,
      ).toBe("USD");
    });
  });
});
