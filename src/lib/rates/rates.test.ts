import { describe, expect, it } from "vitest";
import { dayOf } from "../../../workers/currency/chunks.ts";
import { chunkOf } from "../../test/rates.ts";
import { chunksFor, rateOf, type Rates } from "./rates.ts";
import { fill } from "./reader.ts";

/** The first day of key 5: 2026-01-27. */
const KEY_5 = 5 * 4096;

const RATES: Rates = new Map([
  [
    "USD",
    new Map([
      [4, fill(chunkOf(1.05, 1.06), NaN)],
      [5, fill(chunkOf(1.15, NaN, 1.17), 1.06)],
    ]),
  ],
  ["GBP", new Map([[5, fill(chunkOf(NaN, 0.88), NaN)]])],
]);

describe("rateOf", () => {
  it("gives a currency's rate in force on a day", () => {
    expect(rateOf(RATES, "USD", KEY_5)).toBe(1.15);
    expect(rateOf(RATES, "USD", KEY_5 + 1)).toBe(1.15);
    expect(rateOf(RATES, "USD", KEY_5 + 2)).toBe(1.17);
    expect(rateOf(RATES, "GBP", KEY_5 + 1)).toBe(0.88);
  });

  it("gives the chunk's last rate for a day after its end", () => {
    expect(rateOf(RATES, "USD", KEY_5 + 900)).toBe(1.17);
    expect(rateOf(RATES, "USD", KEY_5 - 1)).toBe(1.06);
  });

  it("reads a day's rate from the chunk of the day's key", () => {
    expect(rateOf(RATES, "USD", 4 * 4096)).toBe(1.05);
    expect(rateOf(RATES, "USD", 4 * 4096 + 1)).toBe(1.06);
  });

  it("has no rate for a day before a currency's first", () => {
    expect(rateOf(RATES, "GBP", KEY_5)).toBeUndefined();
  });

  it("has no rate for a day whose chunk isn't loaded, though others are", () => {
    expect(rateOf(RATES, "GBP", KEY_5 - 1)).toBeUndefined();
    expect(rateOf(RATES, "USD", 6 * 4096)).toBeUndefined();
    expect(rateOf(RATES, "USD", 3 * 4096)).toBeUndefined();
  });

  it("has no rate for a currency without chunks", () => {
    expect(rateOf(RATES, "XTS", KEY_5)).toBeUndefined();
    expect(rateOf(new Map(), "USD", KEY_5)).toBeUndefined();
    expect(rateOf(new Map([["USD", new Map()]]), "USD", KEY_5)).toBeUndefined();
  });

  it("gives the euro 1 on any day, without chunks", () => {
    expect(rateOf(new Map(), "EUR", KEY_5)).toBe(1);
    expect(rateOf(RATES, "EUR", 0)).toBe(1);
    expect(rateOf(RATES, "EUR", 100 * 4096)).toBe(1);
    // 1985: before there was a euro. Nothing else has a rate to go with it.
    expect(rateOf(RATES, "EUR", dayOf("1985-06-01")!)).toBe(1);
  });

  it("has no rate for a day that isn't one, the euro's too", () => {
    expect(rateOf(RATES, "EUR", NaN)).toBeUndefined();
    expect(rateOf(RATES, "EUR", 20_768.5)).toBeUndefined();
    expect(rateOf(RATES, "USD", NaN)).toBeUndefined();
    expect(rateOf(RATES, "USD", Infinity)).toBeUndefined();
  });

  it("tells currencies apart by their case", () => {
    expect(rateOf(RATES, "usd", KEY_5)).toBeUndefined();
    expect(rateOf(RATES, "eur", KEY_5)).toBeUndefined();
  });
});

describe("chunksFor", () => {
  /** What each account displays in: Wallet in every transaction's own, and Gone isn't known. */
  const DISPLAYS: Record<string, string | null | undefined> = { Checking: "USD", Wallet: null };
  const displayOf = ({ account_name }: { account_name: string }) => DISPLAYS[account_name];

  const transaction = (
    naive_date: string,
    currency: string,
    account_name = "Wallet",
    conversions: Record<string, unknown> = {},
  ) => ({ naive_date, currency, account_name, conversions });

  const sorted = (chunks: { currency: string; key: number }[]) =>
    chunks.map(({ currency, key }) => `${currency}-${key}`).toSorted();

  it("is the chunk of each transaction's currency on its day, each once", () => {
    const chunks = chunksFor(
      [
        transaction("2026-10-09", "SGD"),
        transaction("2026-10-01", "SGD"),
        transaction("2026-11-12", "INR"),
        // The last day of key 4, and the first of key 5.
        transaction("2026-01-26", "SGD"),
        transaction("2026-01-27", "JPY"),
        transaction("2003-08-23", "SGD"),
      ],
      displayOf,
    );
    expect(sorted(chunks)).toEqual(["INR-5", "JPY-5", "SGD-2", "SGD-4", "SGD-5"]);
    expect(chunks).toHaveLength(5);
  });

  it("has the chunks of the currencies a transaction is converted to", () => {
    const chunks = chunksFor(
      [transaction("2026-10-09", "SGD", "Wallet", { JPY: {}, INR: {} })],
      displayOf,
    );
    expect(sorted(chunks)).toEqual(["INR-5", "JPY-5", "SGD-5"]);
  });

  it("has the chunk of the currency a transaction's account displays in", () => {
    const chunks = chunksFor(
      [transaction("2026-10-09", "SGD", "Checking"), transaction("2020-05-05", "JPY", "Wallet")],
      displayOf,
    );
    expect(sorted(chunks)).toEqual(["JPY-4", "SGD-5", "USD-5"]);
  });

  it("has nothing for an account's display currency without a transaction of the account", () => {
    expect(sorted(chunksFor([transaction("2026-10-09", "SGD")], displayOf))).toEqual(["SGD-5"]);
  });

  it("has the euro's among them: whoever loads rates knows it has no chunks", () => {
    expect(sorted(chunksFor([transaction("2026-10-09", "EUR")], displayOf))).toEqual(["EUR-5"]);
  });

  it("has the chunks of days there are no rates of: before the first, and yet to come", () => {
    const chunks = chunksFor(
      [transaction("1985-06-01", "SGD"), transaction("2040-01-01", "SGD")],
      displayOf,
    );
    expect(sorted(chunks)).toEqual(["SGD-1", "SGD-6"]);
  });

  it("has none for a transaction whose date isn't one", () => {
    const chunks = chunksFor(
      [transaction("", "SGD"), transaction("2026-02-30", "JPY"), transaction("soon", "INR")],
      displayOf,
    );
    expect(chunks).toEqual([]);
  });

  it("has none without transactions", () => {
    expect(chunksFor([], displayOf)).toEqual([]);
  });

  it("does without the display currency of a transaction it isn't told one for", () => {
    expect(sorted(chunksFor([transaction("2026-10-09", "SGD", "Gone")], displayOf))).toEqual([
      "SGD-5",
    ]);
  });
});
