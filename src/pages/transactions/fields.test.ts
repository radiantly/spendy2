import { describe, expect, it } from "vitest";
import {
  amountEditText,
  findName,
  formatAmount,
  parseAccount,
  parseAmount,
  parseCategory,
  parseCounterparty,
  parseNaiveDate,
  parseRemarks,
} from "./fields.ts";

const r = (numerator: number, denominator = 1) => ({ numerator, denominator });

describe("formatAmount", () => {
  it.each([
    [r(10), "USD", "USD 10.00"],
    [r(-2469, 2), "USD", "USD -1,234.50"],
    [r(100), "INR", "INR 100.00"],
    [r(1500), "JPY", "JPY 1,500"],
    [r(617, 500), "BHD", "BHD 1.234"],
    [r(2469, 2000), "CLF", "CLF 1.2345"],
    [r(10), "POINTS", "POINTS 10.00"],
  ])("formats %o %s as %s", (amount, currency, expected) => {
    expect(formatAmount(amount, currency)).toBe(expected);
  });

  it.each([
    // The float nearest 1.005 is below it, so rounding the float gives 1.00.
    [r(201, 200), "USD 1.01"],
    [r(-201, 200), "USD -1.01"],
    [r(1, 3), "USD 0.33"],
    [r(2, 3), "USD 0.67"],
    [r(-1, 3), "USD -0.33"],
    [r(-1, 300), "USD -0.00"],
  ])("rounds %o half away from zero to %s", (amount, expected) => {
    expect(formatAmount(amount, "USD")).toBe(expected);
  });

  it("formats amounts too large for a float exactly", () => {
    expect(formatAmount(r(9_007_199_254_740_991, 100), "USD")).toBe("USD 90,071,992,547,409.91");
  });
});

describe("amountEditText", () => {
  it.each([
    [r(10), "USD", "10.00"],
    [r(-2469, 2), "USD", "-1234.50"],
    [r(1500), "JPY", "1500"],
    [r(2469, 2000), "CLF", "1.2345"],
    [r(1), "CLF", "1.0000"],
  ])("edits %o %s as %s", (amount, currency, expected) => {
    expect(amountEditText(amount, currency)).toBe(expected);
  });

  it("has only the currency's decimals, so more are rounded", () => {
    expect(amountEditText(r(1, 3), "USD")).toBe("0.33");
    expect(amountEditText(r(246_911, 200), "USD")).toBe("1234.56");
  });

  it("round-trips through parseAmount", () => {
    for (const amount of [r(0), r(1, 100), r(-1, 100), r(9_999, 100), r(-987_654_321, 10)])
      expect(parseAmount(amountEditText(amount, "USD"))).toEqual({ ok: true, value: amount });
  });
});

describe("parseAmount", () => {
  it.each([
    ["10", r(10)],
    ["-12.5", r(-25, 2)],
    ["+3", r(3)],
    ["1,234.56", r(30_864, 25)],
    [" 7 ", r(7)],
    [".5", r(1, 2)],
    ["5.", r(5)],
    ["1.2345", r(2469, 2000)],
    ["1.00005", r(20_001, 20_000)],
    ["10.500", r(21, 2)],
    ["-0.00005", r(-1, 20_000)],
    ["-0", r(0)],
    ["-0.000", r(0)],
  ])("parses %s exactly as %o", (text, expected) => {
    expect(parseAmount(text)).toEqual({ ok: true, value: expected });
  });

  it.each(["", "abc", "1.2.3", "--1", "1e3", ".", "USD 10", "1 000", "1/3"])(
    "rejects %j",
    (text) => {
      expect(parseAmount(text).ok).toBe(false);
    },
  );

  it("rejects amounts beyond what can be stored exactly", () => {
    expect(parseAmount("900719925474.0992")).toEqual({
      ok: false,
      error: "That amount is too large",
    });
  });

  it("accepts the largest amount that can be stored exactly", () => {
    expect(parseAmount("900719925474.0991")).toEqual({
      ok: true,
      value: r(9_007_199_254_740_991, 10_000),
    });
  });

  it("rejects more decimals than can be stored exactly", () => {
    expect(parseAmount("0.0000000000000001")).toEqual({
      ok: false,
      error: "That amount has too many decimals",
    });
  });

  it("accepts trailing zeros past what can be stored, as they don't change the amount", () => {
    expect(parseAmount("1.50000000000000000000")).toEqual({ ok: true, value: r(3, 2) });
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
