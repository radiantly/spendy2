import { describe, expect, it } from "vitest";
import { MANIFEST_PATH, type Manifest, type Rate } from "./format.ts";
import { plan, planAll, windowKeys } from "./plan.ts";
import { ratesOf, servedWith, type Served } from "./test/helpers.ts";

/** The first days of keys 5 and 6: 2026-01-27 and 2037-04-15. */
const KEY_5 = 5 * 4096;
const KEY_6 = 6 * 4096;

/** A day in the middle of key 5's second week: its window is all in key 5. */
const DAY = KEY_5 + 9;

/** Nine days of rates, to the day before `DAY`. */
const NINE = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/** A key 5 chunk ending two days before key 6 starts. */
const NEARLY_FULL = Array.from({ length: 4094 }, (_, index) => index + 1);

/** The states among what's served, by key, as the update reads them. */
function statesOf(served: Served, ...keys: number[]) {
  return new Map(keys.map((key) => [key, served.get(`/${key}`)!]));
}

describe("windowKeys", () => {
  it("is one key when the week before the day is in it", () => {
    expect(windowKeys(KEY_5 + 7)).toEqual([5]);
    expect(windowKeys(KEY_6 - 1)).toEqual([5]);
  });

  it("is two for the first week of a key", () => {
    expect(windowKeys(KEY_6)).toEqual([5, 6]);
    expect(windowKeys(KEY_6 + 6)).toEqual([5, 6]);
  });
});

describe("plan", () => {
  it("writes the window's rates into the chunks and the state", async () => {
    const { served, manifest } = await servedWith({ 5: { USD: NINE, GBP: NINE } });
    const rates: Rate[] = [
      { day: DAY - 1, quote: "USD", rate: 9.5 },
      { day: DAY, quote: "USD", rate: 10 },
      { day: DAY, quote: "GBP", rate: 20 },
    ];
    const planned = await plan(manifest, statesOf(served, 5), rates, DAY);

    expect(planned.changed).toBe(true);
    expect(ratesOf(planned.files.get("/USD-5")!.bytes)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9.5, 10]);
    expect(ratesOf(planned.files.get("/GBP-5")!.bytes)).toEqual([...NINE, 20]);
    expect(ratesOf(planned.files.get("/5")!.bytes)).toEqual([
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9.5, 10],
      ...[...NINE, 20],
    ]);
    expect(planned.manifest.currencies).toEqual(["USD", "GBP"]);
    expect(Object.keys(planned.manifest.assets)).toEqual(["/USD-5", "/GBP-5", "/5"]);
    expect(planned.manifest.assets["/USD-5"]!.size).toBe(80);
  });

  it("deploys the manifest among the assets, though the manifest doesn't list itself", async () => {
    const { served, manifest } = await servedWith({ 5: { USD: NINE } });
    const planned = await plan(
      manifest,
      statesOf(served, 5),
      [{ day: DAY, quote: "USD", rate: 10 }],
      DAY,
    );

    expect(planned.manifest.assets[MANIFEST_PATH]).toBeUndefined();
    expect(planned.assets).toEqual({
      ...planned.manifest.assets,
      [MANIFEST_PATH]: { hash: expect.stringMatching(/^[0-9a-f]{32}$/), size: expect.any(Number) },
    });
    const file = planned.files.get(MANIFEST_PATH)!;
    expect(file.contentType).toBe("application/json");
    expect(JSON.parse(new TextDecoder().decode(file.bytes))).toEqual(planned.manifest);
    expect(planned.assets[MANIFEST_PATH]!.size).toBe(file.bytes.length);
  });

  it("changes nothing when the rates are the ones already there", async () => {
    const { served, manifest } = await servedWith({ 5: { USD: [...NINE, 10], GBP: NINE } });
    const rates: Rate[] = [
      { day: DAY - 1, quote: "USD", rate: 9 },
      { day: DAY, quote: "USD", rate: 10 },
    ];
    const planned = await plan(manifest, statesOf(served, 5), rates, DAY);
    expect(planned.changed).toBe(false);
    expect(planned.manifest).toEqual(manifest);
  });

  it("gives a new hash only to what changed", async () => {
    const { served, manifest } = await servedWith(
      {
        4: { USD: [1], GBP: [2] },
        5: { USD: NINE, GBP: NINE },
      },
      [5],
    );
    const planned = await plan(
      manifest,
      statesOf(served, 5),
      [{ day: DAY, quote: "USD", rate: 10 }],
      DAY,
    );

    const { assets } = planned.manifest;
    expect(assets["/USD-5"]!.hash).not.toBe(manifest.assets["/USD-5"]!.hash);
    expect(assets["/5"]!.hash).not.toBe(manifest.assets["/5"]!.hash);
    expect(assets["/GBP-5"]).toEqual(manifest.assets["/GBP-5"]);
    // The chunks of a key behind the window aren't even looked at.
    expect(assets["/USD-4"]).toEqual(manifest.assets["/USD-4"]);
    expect(assets["/GBP-4"]).toEqual(manifest.assets["/GBP-4"]);
    expect([...planned.files.keys()]).toEqual(["/USD-5", "/GBP-5", "/5", MANIFEST_PATH]);
  });

  it("writes to both keys in the week after a new one starts", async () => {
    const { served, manifest } = await servedWith({ 5: { USD: NEARLY_FULL, GBP: NEARLY_FULL } });
    const rates: Rate[] = [
      // The last days of key 5: one revised, one that came out late.
      { day: KEY_6 - 3, quote: "USD", rate: 0.5 },
      { day: KEY_6 - 1, quote: "USD", rate: 0.25 },
      { day: KEY_6, quote: "USD", rate: 100 },
      { day: KEY_6 + 1, quote: "GBP", rate: 200 },
    ];
    const planned = await plan(manifest, statesOf(served, 5), rates, KEY_6 + 1);

    expect(ratesOf(planned.files.get("/USD-5")!.bytes).slice(-4)).toEqual([4093, 0.5, NaN, 0.25]);
    expect(planned.manifest.assets["/USD-5"]!.size).toBe(4096 * 8);
    expect(planned.manifest.assets["/GBP-5"]).toEqual(manifest.assets["/GBP-5"]);
    expect(ratesOf(planned.files.get("/USD-6")!.bytes)).toEqual([100]);
    expect(ratesOf(planned.files.get("/GBP-6")!.bytes)).toEqual([NaN, 200]);
    expect(ratesOf(planned.files.get("/6")!.bytes)).toEqual([100, NaN, 200]);
    expect(Object.keys(planned.manifest.assets)).toEqual([
      "/USD-5",
      "/GBP-5",
      "/5",
      "/USD-6",
      "/GBP-6",
      "/6",
    ]);
  });

  it("gives a currency new in that week the same place in both keys", async () => {
    const { served, manifest } = await servedWith({ 5: { USD: NEARLY_FULL } });
    const rates: Rate[] = [
      { day: KEY_6, quote: "GBP", rate: 200 },
      { day: KEY_6, quote: "JPY", rate: 300 },
      { day: KEY_6 - 1, quote: "JPY", rate: 299 },
      { day: KEY_6, quote: "USD", rate: 100 },
    ];
    const planned = await plan(manifest, statesOf(served, 5), rates, KEY_6);

    expect(planned.manifest.currencies).toEqual(["USD", "JPY", "GBP"]);
    expect(ratesOf(planned.files.get("/6")!.bytes)).toEqual([100, 300, 200]);
    expect(ratesOf(planned.files.get("/5")!.bytes).slice(-4096)).toEqual(
      ratesOf(planned.files.get("/JPY-5")!.bytes),
    );
    expect(planned.manifest.assets["/GBP-5"]).toBeUndefined();
  });

  it("has no state or chunk for a new key until it has a rate", async () => {
    const { served, manifest } = await servedWith({ 5: { USD: NEARLY_FULL } });
    const planned = await plan(
      manifest,
      statesOf(served, 5),
      [{ day: KEY_6 - 1, quote: "USD", rate: 0.25 }],
      KEY_6,
    );
    expect(Object.keys(planned.manifest.assets)).toEqual(["/USD-5", "/5"]);
    expect([...planned.files.keys()]).toEqual(["/USD-5", "/5", MANIFEST_PATH]);
  });

  it("drops a key's state once the window has left it, and keeps its chunks", async () => {
    const { served, manifest } = await servedWith({
      5: { USD: [...NEARLY_FULL, 4095, 4096] },
      6: { USD: [1, 2, 3, 4, 5, 6, 7] },
    });
    // The last day of the window with key 5 in it, with nothing new.
    const during = await plan(
      manifest,
      statesOf(served, 5, 6),
      [{ day: KEY_6 + 6, quote: "USD", rate: 7 }],
      KEY_6 + 6,
    );
    expect(during.changed).toBe(false);

    const after = await plan(
      manifest,
      statesOf(served, 6),
      [{ day: KEY_6 + 6, quote: "USD", rate: 7 }],
      KEY_6 + 7,
    );
    expect(after.changed).toBe(true);
    expect(Object.keys(after.manifest.assets)).toEqual(["/USD-5", "/USD-6", "/6"]);
    expect(after.manifest.assets["/USD-5"]).toEqual(manifest.assets["/USD-5"]);
    expect(after.assets["/5"]).toBeUndefined();
  });

  it("leaves the manifest it was given alone", async () => {
    const { served, manifest } = await servedWith({ 4: { USD: [1] }, 5: { USD: NINE } });
    const before = structuredClone(manifest);
    await plan(manifest, statesOf(served, 5), [{ day: DAY, quote: "GBP", rate: 20 }], DAY);
    expect(manifest).toEqual(before);
  });
});

describe("planAll", () => {
  /** A day in key 5 whose window is all in it. */
  const TODAY = KEY_5 + 20;

  it("has a chunk for each key a currency has rates in, and a state for the window's", async () => {
    const planned = await planAll(
      [
        { day: KEY_5 - 2, quote: "USD", rate: 1 },
        { day: KEY_5 - 1, quote: "USD", rate: 2 },
        { day: KEY_5 + 1, quote: "USD", rate: 3 },
        { day: KEY_5 + 2, quote: "GBP", rate: 4 },
      ],
      TODAY,
    );

    expect(planned.manifest.currencies).toEqual(["USD", "GBP"]);
    expect(Object.keys(planned.manifest.assets)).toEqual(["/USD-4", "/USD-5", "/GBP-5", "/5"]);
    expect(ratesOf(planned.files.get("/USD-4")!.bytes).slice(-3)).toEqual([NaN, 1, 2]);
    expect(planned.manifest.assets["/USD-4"]!.size).toBe(4096 * 8);
    expect(ratesOf(planned.files.get("/USD-5")!.bytes)).toEqual([NaN, 3]);
    expect(ratesOf(planned.files.get("/5")!.bytes)).toEqual([NaN, 3, NaN, NaN, 4]);
    expect(planned.files.has(MANIFEST_PATH)).toBe(true);
    expect(planned.changed).toBe(true);
  });

  it("orders the currencies by their first day, then their code, however the rates come", async () => {
    const rates: Rate[] = [
      { day: KEY_5 + 3, quote: "AUD", rate: 1 },
      { day: KEY_5 + 1, quote: "USD", rate: 2 },
      { day: KEY_5 + 1, quote: "GBP", rate: 3 },
      { day: KEY_5 - 1, quote: "JPY", rate: 4 },
      { day: KEY_5 + 2, quote: "JPY", rate: 5 },
    ];
    const planned = await planAll(rates, TODAY);
    const reversed = await planAll(rates.toReversed(), TODAY);

    expect(planned.manifest.currencies).toEqual(["JPY", "GBP", "USD", "AUD"]);
    expect(reversed.manifest).toEqual(planned.manifest);
    expect(JSON.stringify(reversed.manifest)).toBe(JSON.stringify(planned.manifest));
  });

  it("keeps the states of both keys in the week after a new one starts", async () => {
    const planned = await planAll(
      [
        { day: KEY_6 - 1, quote: "USD", rate: 1 },
        { day: KEY_6, quote: "USD", rate: 2 },
      ],
      KEY_6 + 3,
    );
    expect(Object.keys(planned.manifest.assets)).toEqual(["/USD-5", "/5", "/USD-6", "/6"]);
  });

  it("comes to the assets the daily plans do, a day at a time", async () => {
    // Three weeks across the start of key 6, with gaps, a late rate and a
    // currency that starts part-way.
    const all: Rate[] = [];
    for (let day = KEY_6 - 10; day <= KEY_6 + 10; day += 1) {
      if (day % 7 !== 0) all.push({ day, quote: "USD", rate: day / 1000 });
      if (day % 3 === 0) all.push({ day, quote: "GBP", rate: day / 2000 });
      if (day >= KEY_6 - 2) all.push({ day, quote: "AUD", rate: day / 3000 });
    }
    /** The day each rate came out: its own, but for one a day late. */
    const outOn = (rate: Rate) =>
      rate.day === KEY_6 - 1 && rate.quote === "USD" ? KEY_6 : rate.day;

    let manifest: Manifest = { currencies: [], assets: {} };
    const served: Served = new Map();
    for (let day = KEY_6 - 10; day <= KEY_6 + 10; day += 1) {
      const window = all.filter((rate) => outOn(rate) <= day && rate.day >= day - 7);
      const states = new Map(
        windowKeys(day).flatMap((key) =>
          served.has(`/${key}`) ? [[key, served.get(`/${key}`)!]] : [],
        ),
      );
      const planned = await plan(manifest, states, window, day);
      for (const [path, file] of planned.files) served.set(path, file.bytes);
      manifest = planned.manifest;
    }

    const whole = await planAll(all, KEY_6 + 10);
    expect(manifest.currencies).toEqual(whole.manifest.currencies);
    expect(manifest.assets).toEqual(whole.manifest.assets);
  });
});
