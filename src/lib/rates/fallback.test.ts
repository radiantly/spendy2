import { describe, expect, it } from "vitest";
import { chunkOf } from "../../test/rates.ts";
import { fallbackAmount, fallbackUnits, type Convertible } from "./fallback.ts";
import type { Rates } from "./rates.ts";
import { fill } from "./reader.ts";

/** The first day of key 5: 2026-01-27. */
const DAY = 5 * 4096;

/** Rates of key 5, by currency: a day each from its first. */
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

function transaction(
  currency: string,
  amount: number,
  conversions: Record<string, number> = {},
  decimals = 2,
): Convertible {
  return {
    currency,
    amount,
    decimals,
    // Each in hundredths, but the yen, which has none.
    conversions: Object.fromEntries(
      Object.entries(conversions).map(([code, converted]) => [
        code,
        { amount: converted, decimals: code === "JPY" ? 0 : 2 },
      ]),
    ),
  };
}

describe("fallbackAmount", () => {
  it("converts the transaction's own amount when it has no conversions", () => {
    // SGD 16.00 is 10 euros, which is USD 12.50.
    expect(fallbackAmount(RATES, transaction("SGD", -1600), DAY, "USD")).toBe(-12.5);
    expect(fallbackAmount(RATES, transaction("SGD", 1600), DAY, "EUR")).toBe(10);
    expect(fallbackAmount(RATES, transaction("EUR", -1000), DAY, "JPY")).toBe(-2000);
  });

  it("reads an amount in its currency's stored decimals", () => {
    expect(fallbackAmount(RATES, transaction("JPY", -2000, {}, 0), DAY, "EUR")).toBe(-10);
    expect(fallbackAmount(RATES, transaction("USD", -12500, {}, 3), DAY, "EUR")).toBe(-10);
  });

  it("converts a stored conversion rather than the transaction's own amount", () => {
    // Its own SGD 16.00 would be USD 12.50: the JPY 2,400 it came to is USD 15.
    const converted = transaction("SGD", -1600, { JPY: -2400 });
    expect(fallbackAmount(RATES, converted, DAY, "USD")).toBe(-15);
  });

  it("takes the largest of its conversions, each converted", () => {
    // JPY 2,400 is USD 15, and INR 1,300.00 is USD 16.25.
    const converted = transaction("SGD", -1600, { JPY: -2400, INR: -130_000 });
    expect(fallbackAmount(RATES, converted, DAY, "USD")).toBe(-16.25);
    // The other way round.
    const other = transaction("SGD", -1600, { JPY: -2800, INR: -130_000 });
    expect(fallbackAmount(RATES, other, DAY, "USD")).toBe(-17.5);
  });

  it("takes the largest whichever way the money went", () => {
    const income = transaction("SGD", 1600, { JPY: 2400, INR: 130_000 });
    expect(fallbackAmount(RATES, income, DAY, "USD")).toBe(16.25);
  });

  it("takes the largest conversion even when the transaction's own amount is larger", () => {
    const converted = transaction("SGD", -160_000, { JPY: -2400 });
    expect(fallbackAmount(RATES, converted, DAY, "USD")).toBe(-15);
  });

  it("leaves out a conversion whose currency has no rate", () => {
    const converted = transaction("SGD", -1600, { JPY: -2400, INR: -130_000, DOGE: -99_999_900 });
    expect(fallbackAmount(RATES, converted, DAY, "USD")).toBe(-16.25);
  });

  it("converts the transaction's own amount when none of its conversions has a rate", () => {
    const converted = transaction("SGD", -1600, { DOGE: -99_999_900, PEPE: -5 });
    expect(fallbackAmount(RATES, converted, DAY, "USD")).toBe(-12.5);
  });

  it("has no amount when neither its conversions nor its own currency has a rate", () => {
    const converted = transaction("XTS", -1600, { DOGE: -99_999_900, PEPE: -5 });
    expect(fallbackAmount(RATES, converted, DAY, "USD")).toBeUndefined();
    expect(fallbackAmount(RATES, transaction("XTS", -1600), DAY, "USD")).toBeUndefined();
  });

  it("converts a conversion when the transaction's own currency has no rate", () => {
    const converted = transaction("XTS", -1600, { JPY: -2400 });
    expect(fallbackAmount(RATES, converted, DAY, "USD")).toBe(-15);
  });

  it("has no amount when the target has no rate, whatever the transaction has", () => {
    const converted = transaction("SGD", -1600, { JPY: -2400 });
    expect(fallbackAmount(RATES, converted, DAY, "XTS")).toBeUndefined();
    expect(fallbackAmount(new Map(), converted, DAY, "USD")).toBeUndefined();
  });

  it("converts to and from the euro without a chunk for it", () => {
    expect(fallbackAmount(new Map(), transaction("EUR", -1000), DAY, "EUR")).toBe(-10);
    expect(fallbackAmount(RATES, transaction("SGD", -1600, { EUR: -1100 }), DAY, "USD")).toBe(
      -13.75,
    );
  });

  it("gives an amount in the target's own currency as it is", () => {
    expect(fallbackAmount(RATES, transaction("USD", -4620), DAY, "USD")).toBe(-46.2);
  });

  it("counts a conversion stored to the target as one among the others", () => {
    // Whoever wants the stored one to win reads it before asking.
    const converted = transaction("SGD", -1600, { USD: -1200, JPY: -2400 });
    expect(fallbackAmount(RATES, converted, DAY, "USD")).toBe(-15);
    expect(fallbackAmount(RATES, transaction("SGD", -1600, { USD: -1200 }), DAY, "USD")).toBe(-12);
  });

  it("uses the rates of the day it's given", () => {
    const rates = ratesOf({ USD: [1.25, 2.5], SGD: [1.6, 1.6] });
    expect(fallbackAmount(rates, transaction("SGD", -1600), DAY, "USD")).toBe(-12.5);
    expect(fallbackAmount(rates, transaction("SGD", -1600), DAY + 1, "USD")).toBe(-25);
    // A day whose chunk isn't loaded.
    expect(fallbackAmount(rates, transaction("SGD", -1600), DAY - 1, "USD")).toBeUndefined();
  });

  it("is zero for an amount of zero", () => {
    expect(fallbackAmount(RATES, transaction("SGD", 0), DAY, "USD")).toBe(0);
  });
});

describe("fallbackUnits", () => {
  it("is the amount as the target stores it, in its decimals", () => {
    // SGD 16.00 is USD 12.50, and 2,000 yen.
    expect(fallbackUnits(RATES, transaction("SGD", -1600), DAY, "USD", 2)).toBe(-1250);
    expect(fallbackUnits(RATES, transaction("SGD", -1600), DAY, "JPY", 0)).toBe(-2000);
    expect(fallbackUnits(RATES, transaction("SGD", -1600), DAY, "USD", 3)).toBe(-12_500);
  });

  it("rounds half a unit away from zero, the same for money in and out", () => {
    // A euro bought 0.8 pounds: 10 pounds is USD 15.625.
    const rates = ratesOf({ USD: [1.25], GBP: [0.8] });
    expect(fallbackUnits(rates, transaction("GBP", -1000), DAY, "USD", 2)).toBe(-1563);
    expect(fallbackUnits(rates, transaction("GBP", 1000), DAY, "USD", 2)).toBe(1563);
    // SGD 1.01 is USD 0.7890625.
    expect(fallbackUnits(RATES, transaction("SGD", -101), DAY, "USD", 2)).toBe(-79);
  });

  it("is undefined when the rates can't tell", () => {
    expect(fallbackUnits(RATES, transaction("XTS", -1600), DAY, "USD", 2)).toBeUndefined();
    expect(fallbackUnits(new Map(), transaction("SGD", -1600), DAY, "USD", 2)).toBeUndefined();
  });

  it("is undefined for what a rate of zero would make infinite, or not a number", () => {
    const rates = ratesOf({ USD: [1.25], SGD: [0] });
    expect(fallbackUnits(rates, transaction("SGD", -1600), DAY, "USD", 2)).toBeUndefined();
    expect(fallbackUnits(rates, transaction("SGD", 0), DAY, "USD", 2)).toBeUndefined();
  });

  it("is zero, never minus zero, for an amount that rounds to nothing", () => {
    for (const amount of [0, -0, -1, 1]) {
      // A hundredth of a Singapore dollar is 0.0078125 dollars: no whole dollar.
      const units = fallbackUnits(RATES, transaction("SGD", amount), DAY, "USD", 0);
      expect(Object.is(units, 0)).toBe(true);
    }
    // Most of a cent, though.
    expect(fallbackUnits(RATES, transaction("SGD", -1), DAY, "USD", 2)).toBe(-1);
  });
});
