import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dateOf } from "./chunks.ts";
import { MANIFEST_PATH, type Manifest } from "./format.ts";
import { FakeCloud } from "./test/fakeCloud.ts";
import { chunkOf, ratesOf, servedWith, type Served } from "./test/helpers.ts";
import { update } from "./update.ts";

/** The first days of keys 5 and 6: 2026-01-27 and 2037-04-15. */
const KEY_5 = 5 * 4096;
const KEY_6 = 6 * 4096;

/** A day in the middle of key 5's second week: its window is all in key 5. */
const DAY = KEY_5 + 9;

/** Nine days of rates, to the day before `DAY`. */
const NINE = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/** A key 5 chunk ending two days before key 6 starts. */
const NEARLY_FULL = Array.from({ length: 4094 }, (_, index) => index + 1);

/** The manifest among what's served. */
function manifestOf(served: Served) {
  return JSON.parse(new TextDecoder().decode(served.get(MANIFEST_PATH))) as Manifest;
}

describe("update", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const row = (day: number, quote: string, rate: number) => ({
    date: dateOf(day),
    base: "EUR",
    quote,
    rate,
  });

  /** A cloud serving these chunks, with `fetch` going to it. */
  async function cloudWith(chunks: Record<number, Record<string, number[]>>) {
    const { served, manifest } = await servedWith(chunks);
    const cloud = new FakeCloud(served);
    cloud.know(manifest.assets);
    vi.stubGlobal("fetch", cloud.fetch);
    return cloud;
  }

  it("reads the manifest, then the state and a week of rates, and deploys what changed", async () => {
    const cloud = await cloudWith({ 5: { USD: NINE, GBP: NINE } });
    const before = manifestOf(cloud.served);
    cloud.rates = [row(DAY, "USD", 10), row(DAY - 1, "USD", 9.5)];

    const result = await update(env, DAY);

    expect(cloud.requests).toEqual([
      "GET https://currency.spendy2.com/manifest.json",
      `GET https://api.frankfurter.dev/v2/rates?from=${dateOf(DAY - 7)}&to=${dateOf(DAY)}&base=EUR`,
      "GET https://currency.spendy2.com/5",
      "POST https://api.cloudflare.com/client/v4/accounts/account/workers/scripts/currency/assets-upload-session",
      "POST https://api.cloudflare.com/client/v4/accounts/account/workers/assets/upload?base64=true",
      "PUT https://api.cloudflare.com/client/v4/accounts/account/workers/scripts/currency",
    ]);
    expect(ratesOf(cloud.served.get("/USD-5")!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9.5, 10]);
    expect(cloud.served.get("/GBP-5")).toEqual(chunkOf(...NINE));
    expect(ratesOf(cloud.served.get("/5")!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9.5, 10, ...NINE]);

    const after = manifestOf(cloud.served);
    expect(Object.keys(after.assets)).toEqual(["/USD-5", "/GBP-5", "/5"]);
    // The chunk that didn't change isn't uploaded again.
    expect(cloud.uploaded).toHaveLength(3);
    expect(cloud.uploaded).toEqual(
      expect.arrayContaining([after.assets["/USD-5"]!.hash, after.assets["/5"]!.hash]),
    );
    expect(after.assets["/GBP-5"]).toEqual(before.assets["/GBP-5"]);
    expect(result).toEqual({
      date: dateOf(DAY),
      rates: 2,
      skipped: 0,
      currencies: 2,
      deploy: { requests: 3, buckets: 1, uploadedFiles: 3, uploadedBytes: expect.any(Number) },
    });
  });

  it("deploys nothing when run again", async () => {
    const cloud = await cloudWith({ 5: { USD: NINE } });
    cloud.rates = [row(DAY, "USD", 10)];
    await update(env, DAY);
    const served = new Map(cloud.served);
    cloud.requests = [];

    const result = await update(env, DAY);

    expect(result.deploy).toBeNull();
    expect(cloud.requests).toEqual([
      "GET https://currency.spendy2.com/manifest.json",
      `GET https://api.frankfurter.dev/v2/rates?from=${dateOf(DAY - 7)}&to=${dateOf(DAY)}&base=EUR`,
      "GET https://currency.spendy2.com/5",
    ]);
    expect(cloud.served).toEqual(served);
    expect(cloud.deploys).toBe(1);
  });

  it("carries the rates across a new key's first week, then lets go of the old state", async () => {
    const cloud = await cloudWith({ 5: { USD: NEARLY_FULL } });

    cloud.rates = [row(KEY_6 - 2, "USD", 4095)];
    await update(env, KEY_6 - 1);
    expect([...cloud.served.keys()].toSorted()).toEqual(["/5", "/USD-5", MANIFEST_PATH]);

    // The last day of key 5 comes out after that day's update ran.
    cloud.rates = [row(KEY_6 - 1, "USD", 4096), row(KEY_6, "USD", 1)];
    await update(env, KEY_6);
    expect([...cloud.served.keys()].toSorted()).toEqual([
      "/5",
      "/6",
      "/USD-5",
      "/USD-6",
      MANIFEST_PATH,
    ]);
    expect(ratesOf(cloud.served.get("/USD-5")!)).toEqual([...NEARLY_FULL, 4095, 4096]);
    expect(ratesOf(cloud.served.get("/USD-6")!)).toEqual([1]);

    cloud.rates = [row(KEY_6 + 7, "USD", 8)];
    cloud.requests = [];
    await update(env, KEY_6 + 7);
    expect(cloud.requests).not.toContain("GET https://currency.spendy2.com/5");
    expect([...cloud.served.keys()].toSorted()).toEqual(["/6", "/USD-5", "/USD-6", MANIFEST_PATH]);
    expect(ratesOf(cloud.served.get("/USD-5")!)).toEqual([...NEARLY_FULL, 4095, 4096]);
    expect(ratesOf(cloud.served.get("/USD-6")!)).toEqual([1, NaN, NaN, NaN, NaN, NaN, NaN, 8]);
  });

  it("writes the rest when some of Frankfurter's rows are bad, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cloud = await cloudWith({ 5: { USD: NINE, GBP: NINE } });
    const bad = { ...row(DAY, "GBP", 0) };
    cloud.rates = [row(DAY, "USD", 10), bad];

    const result = await update(env, DAY);

    expect(result).toMatchObject({ rates: 1, skipped: 1 });
    expect(ratesOf(cloud.served.get("/USD-5")!)).toEqual([...NINE, 10]);
    expect(cloud.served.get("/GBP-5")).toEqual(chunkOf(...NINE));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Skipped 1"), [bad]);
  });

  it.for([
    ["isn't answering", 503, { message: "busy" }, "Reading the rates: 503"],
    ["answers with no rows", 200, [], "none to write"],
    ["answers with something else", 200, { message: "not found" }, "aren't a list"],
  ] as const)("deploys nothing when Frankfurter %s", async ([, status, body, message]) => {
    const cloud = await cloudWith({ 5: { USD: NINE } });
    const served = new Map(cloud.served);
    cloud.ratesStatus = status;
    cloud.rates = body;

    await expect(update(env, DAY)).rejects.toThrow(message);
    expect(cloud.deploys).toBe(0);
    expect(cloud.served).toEqual(served);
  });

  it("fails when the worker has no manifest yet", async () => {
    const cloud = new FakeCloud(new Map());
    vi.stubGlobal("fetch", cloud.fetch);
    await expect(update(env, DAY)).rejects.toThrow("Reading /manifest.json: 404");
  });
});
