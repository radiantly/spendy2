import { describe, expect, it } from "vitest";
import type { ListedTransaction, TransactionRow } from "../../db/queries/transactions.ts";
import { chunksFor, type Rates } from "../../lib/rates/rates.ts";
import { fill } from "../../lib/rates/reader.ts";
import { chunkOf } from "../../test/rates.ts";
import { displayAmountNote, remarksNote } from "./columns.ts";
import { displayAmounts, displayCurrencies, type DisplayAmount } from "./displayAmount.ts";

const ACCOUNTS = [
  { name: "Checking", display_currency: "USD" },
  { name: "Travel", display_currency: "EUR" },
  { name: "Tokyo", display_currency: "JPY" },
  { name: "Brokerage", display_currency: null },
];
const CURRENCIES = [
  { code: "EUR", stored_decimals: 2 },
  { code: "GBP", stored_decimals: 2 },
  { code: "INR", stored_decimals: 2 },
  { code: "JPY", stored_decimals: 0 },
  { code: "SGD", stored_decimals: 2 },
  { code: "USD", stored_decimals: 2 },
];

/** Rates of key 5 (from 2026-01-27), by currency: a day each from its first. */
function ratesOf(byCurrency: Record<string, number[]>): Rates {
  return new Map(
    Object.entries(byCurrency).map(([currency, rates]) => [
      currency,
      new Map([[5, fill(chunkOf(...rates), NaN)]]),
    ]),
  );
}

/** A euro bought 1.25 dollars, 1.6 Singapore dollars, 200 yen and 100 rupees. */
const RATES = ratesOf({ USD: [1.25], SGD: [1.6], JPY: [200], INR: [100] });

function transaction(overrides: Partial<ListedTransaction> = {}): ListedTransaction {
  return {
    id: "t1",
    timestamp: null,
    sort_key: 1,
    naive_date: "2026-10-05",
    account_name: "Checking",
    counterparty: "Hawker Centre",
    category: null,
    amount: -1600,
    decimals: 2,
    currency: "SGD",
    remarks: null,
    transfer_account: null,
    duplicate_of: null,
    conversions: {},
    ...overrides,
  };
}

const amountOf = (overrides: Partial<ListedTransaction> = {}, rates = RATES) =>
  displayAmounts(ACCOUNTS, CURRENCIES, rates)(transaction(overrides));

describe("displayCurrencies", () => {
  const displayOf = displayCurrencies(ACCOUNTS);

  it("is the currency the transaction's account displays in", () => {
    expect(displayOf({ account_name: "Checking" })).toBe("USD");
    expect(displayOf({ account_name: "Tokyo" })).toBe("JPY");
  });

  it("finds the account ignoring case", () => {
    expect(displayOf({ account_name: "checking" })).toBe("USD");
  });

  it("is null for an account that displays each transaction in its own, or isn't known", () => {
    expect(displayOf({ account_name: "Brokerage" })).toBeNull();
    expect(displayOf({ account_name: "Gone" })).toBeNull();
  });

  it("gives the rates' chunks the display currency of an account spelled in another case", () => {
    const chunks = chunksFor(
      [transaction({ account_name: "checking", currency: "SGD" })],
      displayCurrencies(ACCOUNTS),
    );
    expect(chunks.map(({ currency, key }) => `${currency}-${key}`).toSorted()).toEqual([
      "SGD-5",
      "USD-5",
    ]);
  });
});

describe("displayAmounts", () => {
  it("needs none for a transaction in the currency its account displays in", () => {
    expect(amountOf({ currency: "USD" })).toBeNull();
    // Whatever it's converted to.
    expect(
      amountOf({ currency: "USD", conversions: { EUR: { amount: -900, decimals: 2 } } }),
    ).toBeNull();
  });

  it("needs none in an account that displays every transaction in its own currency", () => {
    expect(amountOf({ account_name: "Brokerage" })).toBeNull();
  });

  it("is the conversion stored to the account's currency, whatever the rates say", () => {
    expect(amountOf({ conversions: { USD: { amount: -1199, decimals: 2 } } })).toEqual({
      currency: "USD",
      amount: { amount: -1199, decimals: 2 },
      estimated: false,
    });
    // And whatever else it's converted to.
    expect(
      amountOf({
        conversions: { USD: { amount: -1199, decimals: 2 }, JPY: { amount: -9999, decimals: 0 } },
      }),
    ).toMatchObject({ amount: { amount: -1199 }, estimated: false });
    expect(amountOf({ conversions: { USD: { amount: -1199, decimals: 2 } } }, new Map())).toEqual({
      currency: "USD",
      amount: { amount: -1199, decimals: 2 },
      estimated: false,
    });
  });

  it("is what the rates make of its own amount without any conversion, as an estimate", () => {
    // SGD 16.00 is 10 euros: USD 12.50.
    expect(amountOf()).toEqual({
      currency: "USD",
      amount: { amount: -1250, decimals: 2 },
      estimated: true,
    });
  });

  it("goes by the largest of its other conversions with a rate, before its own amount", () => {
    // JPY 2,400 is USD 15, and INR 1,300.00 is USD 16.25. GBP has no rate.
    expect(
      amountOf({
        conversions: {
          JPY: { amount: -2400, decimals: 0 },
          INR: { amount: -130_000, decimals: 2 },
          GBP: { amount: -99_999_900, decimals: 2 },
        },
      }),
    ).toEqual({ currency: "USD", amount: { amount: -1625, decimals: 2 }, estimated: true });
  });

  it("goes by its own amount when none of its conversions has a rate", () => {
    expect(amountOf({ conversions: { GBP: { amount: -99_999_900, decimals: 2 } } })).toMatchObject({
      amount: { amount: -1250, decimals: 2 },
      estimated: true,
    });
  });

  it("has no amount when the rates can't tell, though it needs one", () => {
    const none = { currency: "USD", amount: null, estimated: false };
    expect(amountOf({ currency: "GBP" })).toEqual(none);
    expect(amountOf({}, new Map())).toEqual(none);
    expect(amountOf({ naive_date: "" })).toEqual(none);
    // Key 4's last day, whose rates aren't here.
    expect(amountOf({ naive_date: "2026-01-26" })).toEqual(none);
  });

  it("rounds to what the account's currency stores", () => {
    // SGD 16.00 is 2,000 yen; SGD 1.01 is USD 0.7890625.
    expect(amountOf({ account_name: "Tokyo" })).toMatchObject({
      currency: "JPY",
      amount: { amount: -2000, decimals: 0 },
    });
    expect(amountOf({ amount: -101 })).toMatchObject({ amount: { amount: -79, decimals: 2 } });
    expect(amountOf({ amount: 101 })).toMatchObject({ amount: { amount: 79, decimals: 2 } });
  });

  it("uses the rates of the transaction's own day", () => {
    const rates = ratesOf({ USD: [1.25, 2.5], SGD: [1.6, 1.6] });
    expect(amountOf({ naive_date: "2026-01-27" }, rates)).toMatchObject({
      amount: { amount: -1250 },
    });
    expect(amountOf({ naive_date: "2026-01-28" }, rates)).toMatchObject({
      amount: { amount: -2500 },
    });
  });

  it("converts to the euro, which needs no rates of its own", () => {
    expect(amountOf({ account_name: "Travel" })).toEqual({
      currency: "EUR",
      amount: { amount: -1000, decimals: 2 },
      estimated: true,
    });
  });

  it("finds the account ignoring case", () => {
    expect(amountOf({ account_name: "checking" })).toMatchObject({ currency: "USD" });
  });

  it("needs none for an account it wasn't given", () => {
    expect(amountOf({ account_name: "Gone" })).toBeNull();
  });

  it("has no estimate in a currency it wasn't given the decimals of", () => {
    const amounts = displayAmounts(ACCOUNTS, [], RATES);
    expect(amounts(transaction())).toEqual({ currency: "USD", amount: null, estimated: false });
  });

  it("gives every transaction its own, asked one after another", () => {
    const amounts = displayAmounts(ACCOUNTS, CURRENCIES, RATES);
    expect(amounts(transaction())).toMatchObject({ amount: { amount: -1250 } });
    expect(amounts(transaction({ amount: -3200 }))).toMatchObject({ amount: { amount: -2500 } });
    expect(amounts(transaction({ currency: "USD" }))).toBeNull();
    expect(amounts(transaction())).toMatchObject({ amount: { amount: -1250 } });
  });
});

describe("displayAmountNote", () => {
  const ROW = transaction() as TransactionRow;
  const noteOf = (display: DisplayAmount | null) =>
    displayAmountNote(ROW, { rowNumberOf: () => undefined, displayAmountOf: () => display });

  it("is a stored conversion in brackets", () => {
    expect(
      noteOf({ currency: "USD", amount: { amount: -5600, decimals: 2 }, estimated: false }),
    ).toBe("($56.00)");
  });

  it("says about, for one the exchange rates made", () => {
    expect(
      noteOf({ currency: "USD", amount: { amount: -1563, decimals: 2 }, estimated: true }),
    ).toBe("(≈ $15.63)");
  });

  it("marks money in with its plus, as the amount before it is", () => {
    expect(
      noteOf({ currency: "USD", amount: { amount: 1563, decimals: 2 }, estimated: true }),
    ).toBe("(≈ +$15.63)");
    expect(
      noteOf({ currency: "JPY", amount: { amount: 2000, decimals: 0 }, estimated: false }),
    ).toBe("(+¥2,000)");
  });

  it("is nothing without an amount, and for a row that needs none", () => {
    expect(noteOf({ currency: "USD", amount: null, estimated: false })).toBeNull();
    expect(noteOf(null)).toBeNull();
  });

  it("asks for the row's own amount", () => {
    const asked: TransactionRow[] = [];
    displayAmountNote(ROW, {
      rowNumberOf: () => undefined,
      displayAmountOf: (row) => {
        asked.push(row);
        return null;
      },
    });
    expect(asked).toEqual([ROW]);
  });
});

describe("remarksNote", () => {
  const ESTIMATE: DisplayAmount = {
    currency: "USD",
    amount: { amount: -1563, decimals: 2 },
    estimated: true,
  };
  const noteOf = (overrides: Partial<TransactionRow>, display: DisplayAmount | null) =>
    remarksNote(
      { ...(transaction() as TransactionRow), ...overrides },
      {
        rowNumberOf: (id) => (id === "t7" ? 7 : undefined),
        displayAmountOf: () => display,
      },
    );

  it("is the row's amount in its account's currency, for a row that isn't marked", () => {
    expect(noteOf({}, ESTIMATE)).toBe("(≈ $15.63)");
  });

  it("is what the row is marked as, for one that needs no such amount", () => {
    expect(noteOf({ transfer_account: "Savings" }, null)).toBe("Transfer to Savings.");
  });

  it("says what the row is marked as first, then the amount", () => {
    expect(noteOf({ transfer_account: "Savings" }, ESTIMATE)).toBe(
      "Transfer to Savings. (≈ $15.63)",
    );
    expect(noteOf({ transfer_account: "Savings", duplicate_of: "t7" }, ESTIMATE)).toBe(
      "Transfer to Savings. Duplicate of transaction 7. (≈ $15.63)",
    );
  });

  it("is nothing for a row with neither", () => {
    expect(noteOf({}, null)).toBeNull();
    expect(noteOf({}, { currency: "USD", amount: null, estimated: false })).toBeNull();
  });
});
