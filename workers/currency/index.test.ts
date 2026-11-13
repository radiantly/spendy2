import { createScheduledController } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dateOf, position, today } from "./chunks.ts";
import { FakeCloud } from "./test/fakeCloud.ts";
import { ratesOf, servedWith } from "./test/helpers.ts";
import worker from "./index.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const MANIFEST = "GET https://currency.spendy2.com/manifest.json";

/**
 * A cloud that `fetch` goes to, serving a dollar chunk of today's key, with
 * Frankfurter having `rate` for today.
 */
async function cloudWithToday(rate: number) {
  const { key } = position(today());
  const { served, manifest } = await servedWith({ [key]: { USD: [1] } });
  const cloud = new FakeCloud(served);
  cloud.know(manifest.assets);
  cloud.rates = [{ date: dateOf(today()), base: "EUR", quote: "USD", rate }];
  vi.stubGlobal("fetch", cloud.fetch);
  return { cloud, path: `/USD-${key}` };
}

/**
 * Has the object run the update. As a promise of the test's own: the one a
 * call to the object gives stands for its result too, and whatever an
 * assertion reads off it is another call, failing unseen when the first does.
 */
async function runUpdate() {
  return await env.UPDATER.getByName("updater").update();
}

describe("the schedule", () => {
  it("runs today's update, and logs what it came to", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { cloud, path } = await cloudWithToday(1.5);

    await worker.scheduled(createScheduledController(), env);

    expect(ratesOf(cloud.served.get(path)!).at(-1)).toBe(1.5);
    expect(cloud.served.get(path)!.length).toBe((position(today()).index + 1) * 8);
    expect(log).toHaveBeenCalledWith(
      "Updated the rates",
      expect.objectContaining({ date: dateOf(today()), rates: 1, skipped: 0, currencies: 1 }),
    );
  });

  it("fails when the update does", async () => {
    const { cloud } = await cloudWithToday(1.5);
    cloud.ratesStatus = 503;

    await expect(worker.scheduled(createScheduledController(), env)).rejects.toThrow(
      "Reading the rates: 503",
    );
    expect(cloud.deploys).toBe(0);
  });

  it("is all that runs the worker", () => {
    expect(Object.keys(worker)).toEqual(["scheduled"]);
  });
});

describe("Updater", () => {
  it("runs one update for two asked for at once", async () => {
    const { cloud } = await cloudWithToday(1.5);

    const [first, second] = await Promise.all([runUpdate(), runUpdate()]);

    expect(cloud.requests.filter((request) => request === MANIFEST)).toHaveLength(1);
    expect(cloud.deploys).toBe(1);
    expect(second).toEqual(first);
  });

  it("runs another once the first is done", async () => {
    const { cloud } = await cloudWithToday(1.5);

    await runUpdate();
    const again = await runUpdate();

    expect(cloud.requests.filter((request) => request === MANIFEST)).toHaveLength(2);
    // The second found nothing to change.
    expect(again.deploy).toBeNull();
    expect(cloud.deploys).toBe(1);
  });

  it("runs another after one that failed", async () => {
    const { cloud, path } = await cloudWithToday(1.5);
    cloud.failing = { deploy: 500 };
    await expect(runUpdate()).rejects.toThrow("Deploying: 500");

    cloud.failing = {};
    await runUpdate();

    expect(ratesOf(cloud.served.get(path)!).at(-1)).toBe(1.5);
  });
});
