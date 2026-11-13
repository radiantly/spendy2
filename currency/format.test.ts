import { describe, expect, it } from "vitest";
import { contentHash, patchState, stateKey, statePath, utf8, type Rate } from "./format.ts";
import { chunkOf, joined, ratesOf, servedWith } from "./test/helpers.ts";

/** The first day of key 5: 2026-01-27. */
const KEY_5 = 5 * 4096;

describe("a state's path", () => {
  it("is its key alone", () => {
    expect(statePath(5)).toBe("/5");
    expect(statePath(-2)).toBe("/-2");
  });

  it("tells a state's path from every other", () => {
    expect(stateKey("/5")).toBe(5);
    expect(stateKey("/-2")).toBe(-2);
    // The lek's chunk, and a currency whose code is digits.
    expect(stateKey("/ALL-5")).toBeUndefined();
    expect(stateKey("/123-5")).toBeUndefined();
    expect(stateKey("/manifest.json")).toBeUndefined();
    expect(stateKey("/")).toBeUndefined();
  });
});

describe("contentHash", () => {
  it("is the first 32 hex digits of the SHA-256", async () => {
    expect(await contentHash(new Uint8Array(0))).toBe("e3b0c44298fc1c149afbf4c8996fb924");
    expect(await contentHash(utf8("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223");
  });

  it("is the same for the same bytes, wherever they are in a buffer", async () => {
    const bytes = joined(chunkOf(1, 2), chunkOf(3, 4));
    expect(await contentHash(bytes.subarray(16))).toBe(await contentHash(chunkOf(3, 4)));
    expect(await contentHash(bytes.subarray(16))).not.toBe(await contentHash(chunkOf(3, 5)));
  });
});

describe("patchState", () => {
  /** USD with two days of key 5, GBP with one, and their state. */
  async function usdAndGbp() {
    const { served, manifest } = await servedWith({ 5: { USD: [1, 2], GBP: [3] } });
    return { manifest, state: served.get("/5")! };
  }

  const rate = (index: number, quote: string, value: number): Rate => ({
    day: KEY_5 + index,
    quote,
    rate: value,
  });

  it("writes a rate over the one its day had", async () => {
    const { manifest, state } = await usdAndGbp();
    const patched = patchState(manifest, state, 5, [rate(1, "USD", 7)]);
    expect(patched.chunks.map(ratesOf)).toEqual([[1, 7], [3]]);
    expect(patched.currencies).toEqual(["USD", "GBP"]);
  });

  it("grows a chunk to a later day, with NaN for the days between", async () => {
    const { manifest, state } = await usdAndGbp();
    const patched = patchState(manifest, state, 5, [rate(3, "GBP", 9)]);
    expect(patched.chunks.map(ratesOf)).toEqual([
      [1, 2],
      [3, NaN, NaN, 9],
    ]);
  });

  it("adds a currency after the others", async () => {
    const { manifest, state } = await usdAndGbp();
    const patched = patchState(manifest, state, 5, [rate(1, "JPY", 160), rate(0, "USD", 8)]);
    expect(patched.currencies).toEqual(["USD", "GBP", "JPY"]);
    expect(patched.chunks.map(ratesOf)).toEqual([[8, 2], [3], [NaN, 160]]);
  });

  it("has the chunks one after the other as the state", async () => {
    const { manifest, state } = await usdAndGbp();
    const patched = patchState(manifest, state, 5, [rate(2, "USD", 7), rate(0, "JPY", 160)]);
    expect(patched.state).toEqual(joined(chunkOf(1, 2, 7), chunkOf(3), chunkOf(160)));
    expect(joined(...patched.chunks)).toEqual(patched.state);
  });

  it("leaves everything as it was without a rate to write", async () => {
    const { manifest, state } = await usdAndGbp();
    const patched = patchState(manifest, state, 5, []);
    expect(patched.state).toEqual(state);
    expect(patched.currencies).toEqual(manifest.currencies);
  });

  it("leaves the state it was given alone", async () => {
    const { manifest, state } = await usdAndGbp();
    const before = state.slice();
    patchState(manifest, state, 5, [rate(0, "USD", 7), rate(5, "GBP", 9)]);
    expect(state).toEqual(before);
  });

  it("leaves out the rates of another key's days", async () => {
    const { manifest, state } = await usdAndGbp();
    const patched = patchState(manifest, state, 5, [
      { day: KEY_5 - 1, quote: "USD", rate: 7 },
      { day: KEY_5 + 4096, quote: "CHF", rate: 7 },
    ]);
    expect(patched.state).toEqual(state);
    // Nor is a currency added for a rate that isn't written.
    expect(patched.currencies).toEqual(["USD", "GBP"]);
  });

  it("starts a key without a state from nothing", async () => {
    const { manifest } = await usdAndGbp();
    const patched = patchState(manifest, undefined, 6, [
      { day: KEY_5 + 4096 + 1, quote: "GBP", rate: 4 },
    ]);
    expect(patched.chunks.map(ratesOf)).toEqual([[], [NaN, 4]]);
    expect(patched.state).toEqual(chunkOf(NaN, 4));
  });

  it("keeps a currency without a chunk in its place among the others", async () => {
    const { served, manifest } = await servedWith({
      4: { USD: [1], XAU: [5], GBP: [2] },
      5: { USD: [1], GBP: [2] },
    });
    const patched = patchState(manifest, served.get("/5"), 5, [rate(1, "GBP", 3)]);
    expect(patched.currencies).toEqual(["USD", "XAU", "GBP"]);
    expect(patched.chunks.map(ratesOf)).toEqual([[1], [], [2, 3]]);
  });

  it("throws for a state that isn't as long as the manifest's chunks", async () => {
    const { manifest, state } = await usdAndGbp();
    expect(() => patchState(manifest, state.subarray(8), 5, [])).toThrow(
      "/5 is 16 bytes, and the manifest's chunks 24",
    );
    expect(() => patchState(manifest, undefined, 5, [])).toThrow(
      "/5 is 0 bytes, and the manifest's chunks 24",
    );
  });
});
