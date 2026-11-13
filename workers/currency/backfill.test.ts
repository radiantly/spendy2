import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backfill, slices, type Slice } from "./backfill.ts";
import { update } from "./update.ts";
import { FIRST_DAY, dateOf, dayOf } from "./chunks.ts";
import { MANIFEST_PATH, type Manifest } from "./format.ts";
import { FakeCloud } from "./test/fakeCloud.ts";
import { ratesOf, servedWith } from "./test/helpers.ts";

const ACCOUNT = { accountId: "account", apiToken: "token" };

/** 2026-11-11: day 288 of key 5. */
const DAY = 20_768;

/** The years from 1999 to 2026. */
const YEARS = 28;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The requests made to Frankfurter, as the days they were for. */
function asked(cloud: FakeCloud) {
  return cloud.requests.flatMap((request) => {
    const url = new URL(request.split(" ")[1]!);
    return url.hostname === "api.frankfurter.dev"
      ? [`${url.searchParams.get("from")} to ${url.searchParams.get("to")}`]
      : [];
  });
}

/**
 * A cloud that `fetch` goes to, where Frankfurter has a dollar rate for the
 * first and last day it is asked for, the rate being the day's number, and a
 * pound rate for the last from 2010.
 */
function fakeCloud() {
  const cloud = new FakeCloud();
  cloud.frankfurter = (from, to) =>
    Response.json([
      { date: from, base: "EUR", quote: "USD", rate: dayOf(from)! },
      { date: to, base: "EUR", quote: "USD", rate: dayOf(to)! },
      ...(to >= "2010" ? [{ date: to, base: "EUR", quote: "GBP", rate: dayOf(to)! / 2 }] : []),
    ]);
  vi.stubGlobal("fetch", cloud.fetch);
  return cloud;
}

function manifestOf(cloud: FakeCloud) {
  return JSON.parse(new TextDecoder().decode(cloud.served.get(MANIFEST_PATH))) as Manifest;
}

describe("slices", () => {
  it("is each year from 1999, the last to the day", () => {
    const years = slices(DAY).map(({ from, to }) => `${dateOf(from)} to ${dateOf(to)}`);
    expect(years).toHaveLength(YEARS);
    expect(years.slice(0, 2)).toEqual(["1999-01-01 to 1999-12-31", "2000-01-01 to 2000-12-31"]);
    expect(years.slice(-2)).toEqual(["2025-01-01 to 2025-12-31", "2026-01-01 to 2026-11-11"]);
  });

  it("has every day once", () => {
    const years = slices(DAY);
    expect(years[0]!.from).toBe(FIRST_DAY);
    expect(years.at(-1)!.to).toBe(DAY);
    for (const [index, { from }] of years.entries())
      if (index > 0) expect(from).toBe(years[index - 1]!.to + 1);
  });

  it("is one day on the first of a year", () => {
    expect(slices(dayOf("2027-01-01")!).at(-1)).toEqual({
      from: dayOf("2027-01-01"),
      to: dayOf("2027-01-01"),
    });
  });
});

describe("backfill", () => {
  it("reads Frankfurter a year at a time, one after the other", async () => {
    const cloud = fakeCloud();
    const told: Slice[] = [];

    await backfill(ACCOUNT, "currency", DAY, { onSlice: (slice) => told.push(slice) });

    expect(asked(cloud)).toEqual(
      slices(DAY).map(({ from, to }) => `${dateOf(from)} to ${dateOf(to)}`),
    );
    // Nothing else until the last year is read.
    expect(cloud.requests.slice(0, YEARS).every((request) => request.includes("frankfurter"))).toBe(
      true,
    );
    expect(told).toHaveLength(YEARS);
    expect(told[0]).toEqual({ from: "1999-01-01", to: "1999-12-31", rates: 2 });
    expect(told.at(-1)).toEqual({ from: "2026-01-01", to: "2026-11-11", rates: 3 });
  });

  it("deploys every currency's chunks, and the state of today's key", async () => {
    const cloud = fakeCloud();

    const result = await backfill(ACCOUNT, "currency", DAY);

    expect([...cloud.served.keys()].toSorted()).toEqual(
      [
        ...["/USD-2", "/USD-3", "/USD-4", "/USD-5"],
        ...["/GBP-3", "/GBP-4", "/GBP-5"],
        "/5",
        MANIFEST_PATH,
      ].toSorted(),
    );
    const manifest = manifestOf(cloud);
    expect(manifest.currencies).toEqual(["USD", "GBP"]);
    expect(Object.keys(manifest.assets).toSorted()).toEqual(
      [...cloud.served.keys()].filter((path) => path !== MANIFEST_PATH).toSorted(),
    );

    // 1999-01-01 is day 2400 of key 2.
    const first = ratesOf(cloud.served.get("/USD-2")!);
    expect(first.slice(0, 2400).every(Number.isNaN)).toBe(true);
    expect(first[2400]).toBe(FIRST_DAY);
    const last = ratesOf(cloud.served.get("/USD-5")!);
    expect(last).toHaveLength(289);
    expect(last.at(-1)).toBe(DAY);
    expect(cloud.served.get("/5")!.length).toBe(289 * 8 * 2);

    expect(result).toEqual({
      rates: YEARS * 2 + 17,
      skipped: [],
      currencies: 2,
      assets: 9,
      deploy: { requests: 3, buckets: 1, uploadedFiles: 9, uploadedBytes: expect.any(Number) },
    });
  });

  it("leaves assets the daily update carries on from", async () => {
    const cloud = fakeCloud();
    await backfill(ACCOUNT, "currency", DAY);
    const before = manifestOf(cloud);

    cloud.frankfurter = undefined;
    cloud.rates = [
      { date: dateOf(DAY), base: "EUR", quote: "USD", rate: DAY },
      { date: dateOf(DAY + 1), base: "EUR", quote: "USD", rate: 7 },
    ];
    const result = await update(env, DAY + 1);

    expect(result.deploy).toMatchObject({ uploadedFiles: 3 });
    expect(ratesOf(cloud.served.get("/USD-5")!).slice(-2)).toEqual([DAY, 7]);
    const after = manifestOf(cloud);
    expect(after.assets["/GBP-5"]).toEqual(before.assets["/GBP-5"]);
    expect(after.assets["/USD-2"]).toEqual(before.assets["/USD-2"]);
  });

  it("changes nothing the daily update wouldn't have when the rates are the same", async () => {
    const cloud = fakeCloud();
    await backfill(ACCOUNT, "currency", DAY);
    cloud.frankfurter = undefined;
    cloud.rates = [{ date: dateOf(DAY), base: "EUR", quote: "USD", rate: DAY }];

    expect((await update(env, DAY)).deploy).toBeNull();
  });

  it("takes the place of whatever the worker had", async () => {
    const { served, manifest } = await servedWith({ 5: { USD: [1, 2], XXX: [3] } });
    served.set("/ALL", new Uint8Array(8));
    const cloud = fakeCloud();
    cloud.served = served;
    cloud.know(manifest.assets);

    await backfill(ACCOUNT, "currency", DAY);

    expect(cloud.served.has("/ALL")).toBe(false);
    expect(cloud.served.has("/XXX-5")).toBe(false);
    expect(ratesOf(cloud.served.get("/USD-5")!).slice(0, 2)).toEqual([NaN, NaN]);
    expect(manifestOf(cloud).currencies).toEqual(["USD", "GBP"]);
  });

  it("uploads nothing when run again with the same rates", async () => {
    const cloud = fakeCloud();
    await backfill(ACCOUNT, "currency", DAY);
    const served = new Map(cloud.served);

    const again = await backfill(ACCOUNT, "currency", DAY);

    expect(again.deploy).toEqual({ requests: 2, buckets: 0, uploadedFiles: 0, uploadedBytes: 0 });
    expect(cloud.served).toEqual(served);
  });

  it("uploads only the chunks a changed rate is in", async () => {
    const cloud = fakeCloud();
    await backfill(ACCOUNT, "currency", DAY);
    const answer = cloud.frankfurter!;
    cloud.frankfurter = (from, to) =>
      from.startsWith("2005")
        ? Response.json([{ date: from, base: "EUR", quote: "USD", rate: 0.5 }])
        : answer(from, to);

    const again = await backfill(ACCOUNT, "currency", DAY);

    // The dollar's chunk with 2005 in it, and the manifest.
    expect(again.deploy.uploadedFiles).toBe(2);
  });

  it("waits as long as Frankfurter asks when it's busy, then asks again", async () => {
    const cloud = fakeCloud();
    const answer = cloud.frankfurter!;
    const busy = [
      new Response(null, { status: 503, headers: { "Retry-After": "30" } }),
      new Response(null, { status: 429 }),
    ];
    cloud.frankfurter = (from, to) =>
      from.startsWith("2001") && busy.length > 0 ? busy.shift()! : answer(from, to);
    const waited: number[] = [];

    await backfill(ACCOUNT, "currency", DAY, {
      wait: async (seconds) => {
        waited.push(seconds);
      },
    });

    expect(waited).toEqual([30, 10]);
    expect(asked(cloud).filter((days) => days.startsWith("2001"))).toHaveLength(3);
    expect(asked(cloud)).toHaveLength(YEARS + 2);
    expect(cloud.deploys).toBe(1);
  });

  it("gives up on a year that stays busy, with nothing deployed", async () => {
    const cloud = fakeCloud();
    const answer = cloud.frankfurter!;
    cloud.frankfurter = (from, to) =>
      from.startsWith("2001") ? new Response(null, { status: 503 }) : answer(from, to);
    const waited: number[] = [];

    await expect(
      backfill(ACCOUNT, "currency", DAY, {
        wait: async (seconds) => {
          waited.push(seconds);
        },
      }),
    ).rejects.toThrow("Reading the rates: 503");

    expect(waited).toEqual([10, 10, 10, 10, 10]);
    expect(asked(cloud).at(-1)).toBe("2001-01-01 to 2001-12-31");
    expect(cloud.deploys).toBe(0);
  });

  it.for([
    ["fails otherwise", () => new Response(null, { status: 500 }), "Reading the rates: 500"],
    ["has no rates for", () => Response.json([]), "none to write"],
    ["answers with something else for", () => Response.json({ message: "?" }), "aren't a list"],
  ] as const)(
    "stops without waiting or deploying when Frankfurter %s a year",
    async ([, bad, message]) => {
      const cloud = fakeCloud();
      const answer = cloud.frankfurter!;
      cloud.frankfurter = (from, to) => (from.startsWith("2001") ? bad() : answer(from, to));
      const wait = vi.fn(async () => {});

      await expect(backfill(ACCOUNT, "currency", DAY, { wait })).rejects.toThrow(message);

      expect(wait).not.toHaveBeenCalled();
      expect(asked(cloud)).toHaveLength(3);
      expect(cloud.deploys).toBe(0);
    },
  );

  it("leaves out the rows that aren't rates, and gives them back", async () => {
    const cloud = fakeCloud();
    const answer = cloud.frankfurter!;
    const bad = { date: "1999-03-01", base: "EUR", quote: "BBD", rate: 0 };
    // The last rates of 1998, which Frankfurter gives with the first of 1999.
    const early = { date: "1998-12-31", base: "EUR", quote: "BBD", rate: 2.4466 };
    cloud.frankfurter = (from, to) =>
      from.startsWith("1999")
        ? Response.json([bad, early, { date: from, base: "EUR", quote: "USD", rate: 1 }])
        : answer(from, to);

    const result = await backfill(ACCOUNT, "currency", DAY);

    expect(result.skipped).toEqual([bad]);
    expect(manifestOf(cloud).currencies).toEqual(["USD", "GBP"]);
    expect(ratesOf(cloud.served.get("/USD-2")!).at(2400)).toBe(1);
  });
});
