import { describe, expect, it } from "vitest";
import { formatMoney, formatMoneyNumber, roundsToZero } from "./money.ts";

/** An amount stored with `decimals`: 1234 with 2 is 12.34. */
const a = (amount: number, decimals: number) => ({ amount, decimals });

describe("formatMoney", () => {
  it.each([
    ["USD", "$1,234.50"],
    ["EUR", "€1,234.50"],
    ["CAD", "CA$1,234.50"],
    ["AUD", "A$1,234.50"],
    ["HKD", "HK$1,234.50"],
    ["CNY", "CN¥1,234.50"],
    // Intl puts a no-break space between a code and the number.
    ["SGD", "SGD 1,234.50"],
    ["CHF", "CHF 1,234.50"],
  ])("shows %s with its own symbol, or its code: %s", (currency, expected) => {
    expect(formatMoney(a(123_450, 2), currency)).toBe(expected);
  });

  it("gives no two currencies the same symbol", () => {
    const currencies = new Map<string, string[]>();
    for (const currency of Intl.supportedValuesOf("currency")) {
      // Only the space before the number goes: some symbols have their own,
      // like the West African CFA franc's `F CFA` (XOF), not the Central's `FCFA` (XAF).
      const symbol = formatMoney(1, currency, { whole: true }).replace("1", "").trim();
      currencies.set(symbol, [...(currencies.get(symbol) ?? []), currency]);
    }
    const shared = [...currencies].filter(([, codes]) => codes.length > 1);
    expect(shared).toEqual([]);
  });

  it("puts text that isn't a currency code after the number", () => {
    expect(formatMoney(a(1000, 2), "POINTS")).toBe("10.00 POINTS");
  });

  it("shows the currency's usual decimals, or whole units", () => {
    expect(formatMoney(a(1500, 0), "JPY")).toBe("¥1,500");
    expect(formatMoney(a(1000, 0), "USD")).toBe("$1,000.00");
    expect(formatMoney(1982.75, "USD", { whole: true })).toBe("$1,983");
  });

  it("rounds a stored amount exactly, half away from zero", () => {
    // The float nearest 1.005 is below it, so rounding the float gives 1.00.
    expect(formatMoney(a(1005, 3), "USD")).toBe("$1.01");
    expect(formatMoney(a(-1005, 3), "USD")).toBe("-$1.01");
  });

  describe("signs", () => {
    it.each([
      ["out", "-$5.00", "$5.00"],
      ["both", "-$5.00", "+$5.00"],
      ["in", "$5.00", "+$5.00"],
    ] as const)("%s: money out is %s, money in %s, zero $0.00", (sign, out, moneyIn) => {
      expect(formatMoney(a(-500, 2), "USD", { sign })).toBe(out);
      expect(formatMoney(a(500, 2), "USD", { sign })).toBe(moneyIn);
      expect(formatMoney(a(0, 2), "USD", { sign })).toBe("$0.00");
    });

    it("shows money out's sign by default", () => {
      expect(formatMoney(a(-500, 2), "USD")).toBe("-$5.00");
      expect(formatMoney(a(500, 2), "USD")).toBe("$5.00");
    });

    it("puts the sign before a code, or before a number that isn't in a currency", () => {
      expect(formatMoney(a(400_000, 2), "SGD", { sign: "in" })).toBe("+SGD 4,000.00");
      expect(formatMoney(a(-400_000, 2), "SGD", { sign: "in" })).toBe("SGD 4,000.00");
      expect(formatMoney(a(1000, 2), "POINTS", { sign: "in" })).toBe("+10.00 POINTS");
    });

    it.each([
      [a(33, 4), "$0.00"],
      [a(-33, 4), "$0.00"],
      [0.4, "$0"],
      [-0.4, "$0"],
    ])("in: signs %o, which rounds to zero, as zero: %s", (amount, expected) => {
      const whole = typeof amount === "number";
      expect(formatMoney(amount, "USD", { whole, sign: "in" })).toBe(expected);
    });

    it("in: signs a number as it does a stored amount", () => {
      expect(formatMoney(-1982.75, "USD", { whole: true, sign: "in" })).toBe("$1,983");
      expect(formatMoney(1982.75, "USD", { whole: true, sign: "in" })).toBe("+$1,983");
    });
  });
});

describe("roundsToZero", () => {
  it.each([
    [a(0, 2), "USD", true],
    [a(1, 2), "USD", false],
    [a(-1, 2), "USD", false],
    [a(49, 4), "USD", true],
    [a(-49, 4), "USD", true],
    [a(50, 4), "USD", false],
    [a(-50, 4), "USD", false],
    [a(4, 1), "JPY", true],
    [a(5, 1), "JPY", false],
    [a(1, 0), "JPY", false],
    [a(4, 3), "POINTS", true],
    [a(5, 3), "POINTS", false],
  ])("%o %s: %s", (amount, currency, expected) => {
    expect(roundsToZero(amount, currency)).toBe(expected);
  });

  it("agrees with what formatMoneyNumber shows", () => {
    for (let amount = -60; amount <= 60; amount++) {
      const shown = formatMoneyNumber(a(amount, 4), "USD");
      expect(roundsToZero(a(amount, 4), "USD"), `${amount} shows as ${shown}`).toBe(
        /^-?0\.00$/.test(shown),
      );
    }
  });
});

describe("formatMoneyNumber", () => {
  it.each([
    [a(1000, 2), "USD", "10.00"],
    [a(-123_450, 2), "USD", "-1,234.50"],
    [a(10_000, 2), "INR", "100.00"],
    [a(1500, 0), "JPY", "1,500"],
    [a(1234, 3), "BHD", "1.234"],
    [a(12_345, 4), "CLF", "1.2345"],
    [a(1000, 2), "POINTS", "10.00"],
  ])("formats %o %s as %s", (amount, currency, expected) => {
    expect(formatMoneyNumber(amount, currency)).toBe(expected);
  });

  it("shows the currency's usual decimals, whatever it's stored with", () => {
    expect(formatMoneyNumber(a(1000, 0), "USD")).toBe("1,000.00");
    expect(formatMoneyNumber(a(150_049, 2), "JPY")).toBe("1,500");
  });

  it.each([
    // The float nearest 1.005 is below it, so rounding the float gives 1.00.
    [a(1005, 3), "1.01"],
    [a(-1005, 3), "-1.01"],
    [a(3333, 4), "0.33"],
    [a(6667, 4), "0.67"],
    [a(-33, 4), "-0.00"],
  ])("rounds %o half away from zero to %s", (amount, expected) => {
    expect(formatMoneyNumber(amount, "USD")).toBe(expected);
  });

  it("formats amounts too large for a float exactly", () => {
    expect(formatMoneyNumber(a(9_007_199_254_740_991, 2), "USD")).toBe("90,071,992,547,409.91");
  });

  it.each([
    ["out", "-5.00", "5.00"],
    ["both", "-5.00", "+5.00"],
    ["in", "5.00", "+5.00"],
  ] as const)("signs as formatMoney does, %s: %s and %s", (sign, out, moneyIn) => {
    expect(formatMoneyNumber(a(-500, 2), "USD", { sign })).toBe(out);
    expect(formatMoneyNumber(a(500, 2), "USD", { sign })).toBe(moneyIn);
    expect(formatMoneyNumber(a(0, 2), "USD", { sign })).toBe("0.00");
  });
});
