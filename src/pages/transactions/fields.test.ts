import { describe, expect, it } from "vitest";
import {
  amountEditText,
  findName,
  nameFinder,
  parseAccount,
  parseAmount,
  parseCategory,
  parseCounterparty,
  parseCurrency,
  parseNaiveDate,
  parseRemarks,
} from "./fields.ts";

/** An amount stored with `decimals`: 1234 with 2 is 12.34. */
const a = (amount: number, decimals: number) => ({ amount, decimals });

describe("amountEditText", () => {
  it.each([
    [a(1000, 2), "+10.00"],
    [a(-123_450, 2), "1,234.50"],
    [a(1500, 0), "+1,500"],
    [a(5, 2), "+0.05"],
    [a(-5, 3), "0.005"],
  ])("edits %o as %s, signed and grouped as the cell shows it", (amount, expected) => {
    expect(amountEditText(amount)).toBe(expected);
  });

  it("edits zero as empty, as an emptied amount is saved", () => {
    expect(amountEditText(a(0, 2))).toBe("");
    expect(amountEditText(a(0, 0))).toBe("");
  });

  it("keeps decimals the currency isn't usually shown with, so editing doesn't round them", () => {
    expect(amountEditText(a(123_456_789, 4))).toBe("+12,345.6789");
  });

  it("keeps every digit of the largest amounts", () => {
    expect(amountEditText(a(9_007_199_254_740_991, 2))).toBe("+90,071,992,547,409.91");
    expect(amountEditText(a(-9_007_199_254_740_991, 2))).toBe("90,071,992,547,409.91");
  });

  it("round-trips through parseAmount", () => {
    for (const amount of [0, 1, -1, 9_999, -987_654_321, 9_007_199_254_740_991])
      expect(parseAmount(amountEditText(a(amount, 2)), 2)).toEqual({ ok: true, value: amount });
  });
});

describe("parseAmount", () => {
  it.each([
    ["10", -1000],
    ["+3", 300],
    ["-12.5", -1250],
    ["1,234.56", -123_456],
    ["+1,234.56", 123_456],
    [" 7 ", -700],
    [" +7 ", 700],
    [".5", -50],
    ["5.", -500],
    ["10.500", -1050],
  ])(
    "parses %s as %d hundredths: money out without a sign or with a minus, in with a plus",
    (text, expected) => {
      expect(parseAmount(text, 2)).toEqual({ ok: true, value: expected });
    },
  );

  it.each(["0", "+0", "-0", "0.00", "-0.000"])("parses %j as 0, not -0", (text) => {
    expect(parseAmount(text, 2)).toEqual({ ok: true, value: 0 });
  });

  it.each([
    ["1.005", -101],
    ["-1.005", -101],
    ["+1.005", 101],
    ["1.00499999", -100],
    ["0.995", -100],
    ["1.2345", -123],
    ["0.004", 0],
    ["+0.004", 0],
  ])("rounds %s half away from zero, to %d hundredths", (text, expected) => {
    expect(parseAmount(text, 2)).toEqual({ ok: true, value: expected });
  });

  it("parses into the decimals the currency is stored with", () => {
    expect(parseAmount("1500", 0)).toEqual({ ok: true, value: -1500 });
    expect(parseAmount("1499.5", 0)).toEqual({ ok: true, value: -1500 });
    expect(parseAmount("1.2345", 4)).toEqual({ ok: true, value: -12_345 });
    expect(parseAmount("+1.5", 4)).toEqual({ ok: true, value: 15_000 });
  });

  it.each(["", "   "])("reads %j as 0", (text) => {
    expect(parseAmount(text, 2)).toEqual({ ok: true, value: 0 });
  });

  it.each([
    "abc",
    "1.2.3",
    "--1",
    "++1",
    "+-1",
    "-+1",
    "1e3",
    ".",
    "-",
    "+",
    ",",
    "USD 10",
    "$10",
    "1 000",
    "1/3",
  ])("rejects %j", (text) => {
    expect(parseAmount(text, 2)).toEqual({
      ok: false,
      error: "Enter an amount, like 12.50, or +12.50 for money in",
    });
  });

  it("rejects amounts beyond what can be stored exactly", () => {
    expect(parseAmount("90071992547409.92", 2)).toEqual({
      ok: false,
      error: "That amount is too large",
    });
    expect(parseAmount("+90071992547409.92", 2)).toEqual({
      ok: false,
      error: "That amount is too large",
    });
  });

  it("accepts the largest amounts that can be stored exactly", () => {
    expect(parseAmount("90071992547409.91", 2)).toEqual({
      ok: true,
      value: -9_007_199_254_740_991,
    });
    expect(parseAmount("+90071992547409.91", 2)).toEqual({
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
    expect(parseAmount("1.50000000000000000001", 2)).toEqual({ ok: true, value: -150 });
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

describe("parseCurrency", () => {
  const EUR = { code: "EUR", stored_decimals: 2 };
  const CURRENCIES = [EUR, { code: "JPY", stored_decimals: 0 }];

  it.each(["EUR", " eur ", "Eur"])(
    "finds the currency %j is the code of, ignoring case",
    (text) => {
      expect(parseCurrency(text, CURRENCIES)).toEqual({ ok: true, value: EUR });
    },
  );

  it("rejects a code that isn't a currency's", () => {
    expect(parseCurrency("XYZ", CURRENCIES)).toEqual({
      ok: false,
      error: "There's no currency “XYZ”",
    });
  });

  it("rejects an empty code", () => {
    expect(parseCurrency("  ", CURRENCIES)).toEqual({
      ok: false,
      error: "Enter a currency, like USD",
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
