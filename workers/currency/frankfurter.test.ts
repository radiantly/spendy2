import { afterEach, describe, expect, it, vi } from "vitest";
import { dateOf } from "./chunks.ts";
import { FrankfurterError, fetchRates, parseRates } from "./frankfurter.ts";

/** A day, and the one its week of rates starts on. */
const DAY = 5 * 4096 + 9;
const FROM = DAY - 7;

describe("parseRates", () => {
  const row = (changes: Record<string, unknown> = {}) => ({
    date: dateOf(DAY),
    base: "EUR",
    quote: "USD",
    rate: 1.1,
    ...changes,
  });

  it("takes Frankfurter's rows as rates by day", () => {
    const body = [row(), row({ date: dateOf(DAY - 7), quote: "BTC", rate: 0.00001 })];
    expect(parseRates(body, FROM, DAY)).toEqual({
      rates: [
        { day: DAY, quote: "USD", rate: 1.1 },
        { day: DAY - 7, quote: "BTC", rate: 0.00001 },
      ],
      skipped: [],
    });
  });

  it.for([
    ["a code that isn't one", row({ quote: "usd" })],
    ["a code that would be a path of its own", row({ quote: "../USD" })],
    ["a code with a dash", row({ quote: "US-D" })],
    ["no code", row({ quote: "" })],
    ["a date that isn't one", row({ date: "2026-02-30" })],
    ["a date with a time", row({ date: `${dateOf(DAY)}T00:00:00Z` })],
    ["a day after today", row({ date: dateOf(DAY + 1) })],
    ["no rate", row({ rate: null })],
    ["a rate as text", row({ rate: "1.1" })],
    ["a rate of zero", row({ rate: 0 })],
    ["a rate below zero", row({ rate: -1.1 })],
    ["a rate that isn't finite", row({ rate: Infinity })],
    ["nothing", null],
    ["a number", 7],
  ] as const)("skips a row with %s", ([, bad]) => {
    expect(parseRates([row(), bad], FROM, DAY)).toEqual({
      rates: [{ day: DAY, quote: "USD", rate: 1.1 }],
      skipped: [bad],
    });
  });

  it("leaves out a rate of a day before the first without calling it skipped", () => {
    // What Frankfurter gives for a currency without a rate on the first day.
    const body = [row(), row({ date: dateOf(FROM - 1) }), row({ date: dateOf(FROM - 400) })];
    expect(parseRates(body, FROM, DAY)).toEqual({
      rates: [{ day: DAY, quote: "USD", rate: 1.1 }],
      skipped: [],
    });
    expect(parseRates([row({ date: dateOf(FROM) })], FROM, DAY).rates).toHaveLength(1);
    expect(() => parseRates([row({ date: dateOf(FROM - 1) })], FROM, DAY)).toThrow("none to write");
  });

  it("leaves out the euro's own rate without calling it skipped", () => {
    expect(parseRates([row(), row({ quote: "EUR", rate: 1 })], FROM, DAY)).toEqual({
      rates: [{ day: DAY, quote: "USD", rate: 1.1 }],
      skipped: [],
    });
  });

  it("throws for an answer that isn't rows, or has no rate", () => {
    expect(() => parseRates({ message: "not found" }, FROM, DAY)).toThrow("aren't a list");
    expect(() => parseRates([], FROM, DAY)).toThrow("none to write");
    expect(() => parseRates([row({ rate: 0 })], FROM, DAY)).toThrow("none to write");
  });
});

describe("fetchRates", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks for the days' rates to the euro, and gives those to write", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(url);
      return Response.json([
        { date: dateOf(DAY), base: "EUR", quote: "USD", rate: 1.1 },
        { date: dateOf(FROM - 1), base: "EUR", quote: "USD", rate: 1.2 },
        { date: dateOf(DAY), base: "EUR", quote: "GBP", rate: 0 },
      ]);
    });

    expect(await fetchRates(FROM, DAY)).toEqual({
      rates: [{ day: DAY, quote: "USD", rate: 1.1 }],
      skipped: [{ date: dateOf(DAY), base: "EUR", quote: "GBP", rate: 0 }],
    });
    expect(asked).toEqual([
      `https://api.frankfurter.dev/v2/rates?from=${dateOf(FROM)}&to=${dateOf(DAY)}&base=EUR`,
    ]);
  });

  it.for([
    ["30", 30],
    ["0", 0],
    [null, undefined],
    ["Wed, 21 Oct 2026 07:28:00 GMT", undefined],
  ] as const)(
    "throws what Frankfurter said when it's busy, Retry-After %j",
    async ([header, seconds]) => {
      vi.stubGlobal(
        "fetch",
        async () =>
          new Response("busy", {
            status: 503,
            headers: header === null ? {} : { "Retry-After": header },
          }),
      );

      const error = await fetchRates(FROM, DAY).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(FrankfurterError);
      expect(error).toMatchObject({ message: "Reading the rates: 503", status: 503 });
      expect((error as FrankfurterError).retryAfter).toBe(seconds);
    },
  );
});
