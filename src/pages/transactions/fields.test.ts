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

describe("formatAmount", () => {
  it.each([
    [100_000, "USD", "USD 10.00"],
    [-12_345_000, "USD", "USD -1,234.50"],
    [1_000_000, "INR", "INR 100.00"],
    [15_000_000, "JPY", "JPY 1,500"],
    [12_340, "BHD", "BHD 1.234"],
    [12_345, "CLF", "CLF 1.2345"],
    [100_000, "POINTS", "POINTS 10.00"],
  ])("formats %i %s as %s", (amount, currency, expected) => {
    expect(formatAmount(amount, currency)).toBe(expected);
  });
});

describe("amountEditText", () => {
  it.each([
    [100_000, "USD", "10.00"],
    [-12_345_000, "USD", "-1234.50"],
    [12_345_055, "USD", "1234.5055"],
    [15_000_000, "JPY", "1500"],
    [12_345, "CLF", "1.2345"],
    [10_000, "CLF", "1.0000"],
  ])("edits %i %s as %s", (amount, currency, expected) => {
    expect(amountEditText(amount, currency)).toBe(expected);
  });

  it("round-trips through parseAmount", () => {
    for (const amount of [0, 1, -1, 9_999, 12_345_055, -987_654_321_000])
      expect(parseAmount(amountEditText(amount, "USD"))).toEqual({ ok: true, value: amount });
  });
});

describe("parseAmount", () => {
  it.each([
    ["10", 100_000],
    ["-12.5", -125_000],
    ["+3", 30_000],
    ["1,234.56", 12_345_600],
    [" 7 ", 70_000],
    [".5", 5_000],
    ["5.", 50_000],
    ["1.2345", 12_345],
    ["1.00005", 10_001],
    ["1.000049", 10_000],
    ["-0.00005", -1],
    ["0.99995", 10_000],
    ["-0", 0],
  ])("parses %s as %i", (text, expected) => {
    expect(parseAmount(text)).toEqual({ ok: true, value: expected });
  });

  it.each(["", "abc", "1.2.3", "--1", "1e3", ".", "USD 10", "1 000"])("rejects %j", (text) => {
    expect(parseAmount(text).ok).toBe(false);
  });

  it("rejects amounts beyond what can be stored exactly", () => {
    expect(parseAmount("900719925474.0992")).toEqual({
      ok: false,
      error: "That amount is too large",
    });
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
