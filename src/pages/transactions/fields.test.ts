import { describe, expect, it } from "vitest";
import {
  amountEditText,
  findName,
  formatAmount,
  nameFinder,
  parseAccount,
  parseAmount,
  parseCategory,
  parseCounterparty,
  parseNaiveDate,
  parseRemarks,
} from "./fields.ts";

/** An amount stored with `decimals`: 1234 with 2 is 12.34. */
const a = (amount: number, decimals: number) => ({ amount, decimals });

describe("formatAmount", () => {
  it.each([
    [a(1000, 2), "USD", "USD 10.00"],
    [a(-123_450, 2), "USD", "USD -1,234.50"],
    [a(10_000, 2), "INR", "INR 100.00"],
    [a(1500, 0), "JPY", "JPY 1,500"],
    [a(1234, 3), "BHD", "BHD 1.234"],
    [a(12_345, 4), "CLF", "CLF 1.2345"],
    [a(1000, 2), "POINTS", "POINTS 10.00"],
  ])("formats %o %s as %s", (amount, currency, expected) => {
    expect(formatAmount(amount, currency)).toBe(expected);
  });

  it("shows the currency's usual decimals, whatever it's stored with", () => {
    expect(formatAmount(a(1000, 0), "USD")).toBe("USD 1,000.00");
    expect(formatAmount(a(150_049, 2), "JPY")).toBe("JPY 1,500");
  });

  it.each([
    // The float nearest 1.005 is below it, so rounding the float gives 1.00.
    [a(1005, 3), "USD 1.01"],
    [a(-1005, 3), "USD -1.01"],
    [a(3333, 4), "USD 0.33"],
    [a(6667, 4), "USD 0.67"],
    [a(-33, 4), "USD -0.00"],
  ])("rounds %o half away from zero to %s", (amount, expected) => {
    expect(formatAmount(amount, "USD")).toBe(expected);
  });

  it("formats amounts too large for a float exactly", () => {
    expect(formatAmount(a(9_007_199_254_740_991, 2), "USD")).toBe("USD 90,071,992,547,409.91");
  });
});

describe("amountEditText", () => {
  it.each([
    [a(1000, 2), "10.00"],
    [a(-123_450, 2), "-1234.50"],
    [a(1500, 0), "1500"],
    [a(5, 2), "0.05"],
    [a(-5, 3), "-0.005"],
    [a(0, 2), "0.00"],
  ])("edits %o as %s", (amount, expected) => {
    expect(amountEditText(amount)).toBe(expected);
  });

  it("keeps decimals the currency isn't usually shown with, so editing doesn't round them", () => {
    expect(amountEditText(a(123_456, 4))).toBe("12.3456");
  });

  it("round-trips through parseAmount", () => {
    for (const amount of [0, 1, -1, 9_999, -987_654_321])
      expect(parseAmount(amountEditText(a(amount, 2)), 2)).toEqual({ ok: true, value: amount });
  });
});

describe("parseAmount", () => {
  it.each([
    ["10", 1000],
    ["-12.5", -1250],
    ["+3", 300],
    ["1,234.56", 123_456],
    [" 7 ", 700],
    [".5", 50],
    ["5.", 500],
    ["10.500", 1050],
    ["-0", 0],
    ["-0.000", 0],
  ])("parses %s as %d hundredths", (text, expected) => {
    expect(parseAmount(text, 2)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ["1.005", 101],
    ["-1.005", -101],
    ["1.00499999", 100],
    ["0.995", 100],
    ["1.2345", 123],
    ["-0.004", 0],
  ])("rounds %s half away from zero, to %d hundredths", (text, expected) => {
    expect(parseAmount(text, 2)).toEqual({ ok: true, value: expected });
  });

  it("parses into the decimals the currency is stored with", () => {
    expect(parseAmount("1500", 0)).toEqual({ ok: true, value: 1500 });
    expect(parseAmount("1499.5", 0)).toEqual({ ok: true, value: 1500 });
    expect(parseAmount("1.2345", 4)).toEqual({ ok: true, value: 12_345 });
    expect(parseAmount("1.5", 4)).toEqual({ ok: true, value: 15_000 });
  });

  it.each(["", "abc", "1.2.3", "--1", "1e3", ".", "USD 10", "1 000", "1/3"])(
    "rejects %j",
    (text) => {
      expect(parseAmount(text, 2).ok).toBe(false);
    },
  );

  it("rejects amounts beyond what can be stored exactly", () => {
    expect(parseAmount("90071992547409.92", 2)).toEqual({
      ok: false,
      error: "That amount is too large",
    });
  });

  it("accepts the largest amount that can be stored exactly", () => {
    expect(parseAmount("90071992547409.91", 2)).toEqual({
      ok: true,
      value: 9_007_199_254_740_991,
    });
  });

  it("rejects an amount that rounds up past what can be stored", () => {
    expect(parseAmount("90071992547409.915", 2)).toEqual({
      ok: false,
      error: "That amount is too large",
    });
  });

  it("ignores decimals far past the stored ones", () => {
    expect(parseAmount("1.50000000000000000001", 2)).toEqual({ ok: true, value: 150 });
  });
});

describe("parseNaiveDate", () => {
  it.each(["2026-10-10", "2024-02-29", " 2026-01-01 "])("accepts %j", (text) => {
    expect(parseNaiveDate(text)).toEqual({ ok: true, value: text.trim() });
  });

  it.each([
    "2026-02-30",
    "2025-02-29",
    "2026-13-01",
    "2026-1-5",
    "10/10/2026",
    "2026-10-10T00:00",
    "",
  ])("rejects %j", (text) => {
    expect(parseNaiveDate(text).ok).toBe(false);
  });
});

describe("parseCounterparty", () => {
  it("trims", () => {
    expect(parseCounterparty("  Café Lumen ")).toEqual({ ok: true, value: "Café Lumen" });
  });

  it("rejects an empty counterparty", () => {
    expect(parseCounterparty("   ").ok).toBe(false);
  });
});

describe("parseRemarks", () => {
  it("clears empty remarks", () => {
    expect(parseRemarks("  ")).toEqual({ ok: true, value: null });
  });
});

describe("findName", () => {
  it("finds a name typed in another case", () => {
    expect(findName(["Groceries"], " groceries ")).toBe("Groceries");
  });

  // SQLite's NOCASE only folds A-Z, so these can both exist.
  it("prefers the exact name when several differ only in case", () => {
    expect(findName(["épicerie", "Épicerie"], "Épicerie")).toBe("Épicerie");
  });
});

describe("nameFinder", () => {
  // The same cases as findName's, which it stands in for.
  it("finds a name typed in another case", () => {
    expect(nameFinder(["Groceries"])(" groceries ")).toBe("Groceries");
  });

  it("prefers the exact name when several differ only in case", () => {
    const find = nameFinder(["épicerie", "Épicerie"]);

    expect(find("Épicerie")).toBe("Épicerie");
    expect(find("épicerie")).toBe("épicerie");
  });

  it("finds the first of several differing only in case, as findName does", () => {
    const names = ["épicerie", "Épicerie"];

    expect(nameFinder(names)("ÉPICERIE")).toBe(findName(names, "ÉPICERIE"));
  });

  it("finds nothing for a name that isn't there", () => {
    expect(nameFinder(["Groceries"])("Rent")).toBeUndefined();
  });
});

describe("parseCategory", () => {
  const categories = ["Dining out", "Groceries"];

  it("accepts an existing category", () => {
    expect(parseCategory(" Groceries ", categories)).toEqual({ ok: true, value: "Groceries" });
  });

  it("uses the existing spelling of a category typed in other case", () => {
    expect(parseCategory("groceries", categories)).toEqual({ ok: true, value: "Groceries" });
  });

  it("clears an empty category", () => {
    expect(parseCategory("", categories)).toEqual({ ok: true, value: null });
  });

  it("rejects an unknown category", () => {
    expect(parseCategory("Rent", categories)).toEqual({
      ok: false,
      error: "There's no category named “Rent”",
    });
  });

  it("accepts a new category when creating", () => {
    expect(parseCategory(" Rent ", categories, true)).toEqual({ ok: true, value: "Rent" });
  });

  it("uses an existing category even when creating", () => {
    expect(parseCategory("GROCERIES", categories, true)).toEqual({
      ok: true,
      value: "Groceries",
    });
  });
});

describe("parseAccount", () => {
  const accounts = ["Everyday Checking", "Savings"];

  it("accepts an existing account, in any case", () => {
    expect(parseAccount(" savings ", accounts)).toEqual({ ok: true, value: "Savings" });
  });

  it("rejects an unknown account", () => {
    expect(parseAccount("fdsafjsdoif", accounts)).toEqual({
      ok: false,
      error: "There's no account named “fdsafjsdoif”",
    });
  });

  it("rejects an empty account", () => {
    expect(parseAccount("  ", accounts)).toEqual({ ok: false, error: "Choose an account" });
  });
});
