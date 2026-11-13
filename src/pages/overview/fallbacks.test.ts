import { describe, expect, it } from "vitest";
import type { UnconvertedTransaction } from "../../db/queries/overview.ts";
import type { Rates } from "../../lib/rates/rates.ts";
import { fill } from "../../lib/rates/reader.ts";
import { chunkOf } from "../../test/rates.ts";
import { fallbackChunks, fallbacksFor } from "./fallbacks.ts";

/** Rates of key 5 (from 2026-01-27), by currency: the same every day. */
function ratesOf(byCurrency: Record<string, number>): Rates {
  return new Map(
    Object.entries(byCurrency).map(([currency, rate]) => [
      currency,
      new Map([[5, fill(chunkOf(rate), NaN)]]),
    ]),
  );
}

/** A euro bought 1.25 dollars, 1.6 Singapore dollars, 200 yen and 100 rupees. */
const RATES = ratesOf({ USD: 1.25, SGD: 1.6, JPY: 200, INR: 100 });

let count = 0;
function unconverted(
  overrides: Partial<Omit<UnconvertedTransaction, "conversions">> & {
    conversions?: Record<string, { amount: number; decimals: number }>;
  } = {},
): UnconvertedTransaction {
  count++;
  const { conversions = {}, ...rest } = overrides;
  return {
    id: `t${count}`,
    naive_date: "2026-10-05",
    currency: "SGD",
    amount: -1600,
    decimals: 2,
    display: "USD",
    display_decimals: 2,
    conversions: JSON.stringify(conversions),
    ...rest,
  };
}

describe("fallbacksFor", () => {
  it("gives a transaction its amount in its account's currency, as that currency stores it", () => {
    // SGD 16.00 is 10 euros: USD 12.50.
    const transaction = unconverted();
    expect(fallbacksFor([transaction], RATES)).toEqual([[transaction.id, -1250]]);
  });

  it("rounds to the display currency's stored decimals", () => {
    const yen = unconverted({ display: "JPY", display_decimals: 0 });
    // SGD 1.01 is USD 0.7890625.
    const cents = unconverted({ amount: -101 });
    const income = unconverted({ amount: 101 });
    expect(fallbacksFor([yen, cents, income], RATES)).toEqual([
      [yen.id, -2000],
      [cents.id, -79],
      [income.id, 79],
    ]);
  });

  it("rounds half a unit away from zero, the same for money in and out", () => {
    // A euro bought 0.8 pounds: 10 pounds is USD 15.625.
    const rates = ratesOf({ USD: 1.25, GBP: 0.8 });
    const out = unconverted({ currency: "GBP", amount: -1000 });
    const back = unconverted({ currency: "GBP", amount: 1000 });
    expect(fallbacksFor([out, back], rates)).toEqual([
      [out.id, -1563],
      [back.id, 1563],
    ]);
  });

  it("reads the transaction's amount in its own currency's stored decimals", () => {
    const yen = unconverted({ currency: "JPY", amount: -2000, decimals: 0 });
    expect(fallbacksFor([yen], RATES)).toEqual([[yen.id, -1250]]);
  });

  it("goes by the largest of the transaction's conversions with a rate", () => {
    // JPY 2,400 is USD 15, and INR 1,300.00 is USD 16.25. DOGE has no rate.
    const transaction = unconverted({
      conversions: {
        JPY: { amount: -2400, decimals: 0 },
        INR: { amount: -130_000, decimals: 2 },
        DOGE: { amount: -99_999_900, decimals: 2 },
      },
    });
    expect(fallbacksFor([transaction], RATES)).toEqual([[transaction.id, -1625]]);
  });

  it("goes by the transaction's own amount when none of its conversions has a rate", () => {
    const transaction = unconverted({
      conversions: { DOGE: { amount: -99_999_900, decimals: 2 } },
    });
    expect(fallbacksFor([transaction], RATES)).toEqual([[transaction.id, -1250]]);
  });

  it("leaves out a transaction the rates can't give an amount", () => {
    const noRate = unconverted({ currency: "XTS" });
    const noTarget = unconverted({ display: "XTS" });
    const noDate = unconverted({ naive_date: "" });
    // Key 4's last day, whose rates aren't loaded.
    const notLoaded = unconverted({ naive_date: "2026-01-26" });
    const fine = unconverted();
    expect(fallbacksFor([noRate, noTarget, noDate, notLoaded, fine], RATES)).toEqual([
      [fine.id, -1250],
    ]);
  });

  it("gives none without rates, and none without transactions", () => {
    expect(fallbacksFor([unconverted()], new Map())).toEqual([]);
    expect(fallbacksFor([], RATES)).toEqual([]);
  });

  it("converts to and from the euro without rates for it", () => {
    const toEuro = unconverted({ display: "EUR" });
    const fromEuro = unconverted({ currency: "EUR", amount: -1000 });
    expect(fallbacksFor([toEuro, fromEuro], RATES)).toEqual([
      [toEuro.id, -1000],
      [fromEuro.id, -1250],
    ]);
  });

  it("gives zero as zero, which JSON can say", () => {
    const tiny = unconverted({ amount: -0 });
    const [[, amount]] = fallbacksFor([tiny], RATES) as [[string, number]];
    expect(Object.is(amount, 0)).toBe(true);
    expect(JSON.stringify(fallbacksFor([tiny], RATES))).toBe(`[["${tiny.id}",0]]`);
  });

  it("leaves out an amount a rate of zero would make infinite", () => {
    const rates = ratesOf({ USD: 1.25, SGD: 0 });
    expect(fallbacksFor([unconverted()], rates)).toEqual([]);
  });
});

describe("fallbackChunks", () => {
  const names = (transactions: UnconvertedTransaction[]) =>
    fallbackChunks(transactions)
      .map(({ currency, key }) => `${currency}-${key}`)
      .toSorted();

  it("is the chunks of each transaction's currency and its account's, on its day", () => {
    expect(names([unconverted(), unconverted({ naive_date: "2020-05-05" })])).toEqual([
      "SGD-4",
      "SGD-5",
      "USD-4",
      "USD-5",
    ]);
  });

  it("has the chunks of the currencies a transaction is converted to", () => {
    const transaction = unconverted({
      conversions: { JPY: { amount: -2400, decimals: 0 }, INR: { amount: -1, decimals: 2 } },
    });
    expect(names([transaction])).toEqual(["INR-5", "JPY-5", "SGD-5", "USD-5"]);
  });

  it("has each account's own display currency for its transactions", () => {
    expect(
      names([
        unconverted({ display: "USD" }),
        unconverted({ display: "EUR", naive_date: "2020-05-05" }),
      ]),
    ).toEqual(["EUR-4", "SGD-4", "SGD-5", "USD-5"]);
  });

  it("is none without transactions", () => {
    expect(names([])).toEqual([]);
  });
});
