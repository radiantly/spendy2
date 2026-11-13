import { describe, expect, it } from "vitest";
import { chunkPath, dateOf, dayOf, position } from "./chunks.ts";

/** The first day of key 5: 2026-01-27. */
const KEY_5 = 5 * 4096;

describe("days and dates", () => {
  it("numbers a day from 1970-01-01", () => {
    expect(dayOf("1970-01-01")).toBe(0);
    expect(dayOf("2026-11-11")).toBe(20_768);
    expect(dayOf("2024-02-29")).toBe(19_782);
    expect(dayOf("1969-12-31")).toBe(-1);
  });

  it("gives a day's number its date back", () => {
    for (const day of [-1, 0, 10_592, 19_782, 20_768, 24_576]) expect(dayOf(dateOf(day))).toBe(day);
    expect(dateOf(20_768 - 7)).toBe("2026-11-04");
  });

  it.for([
    "",
    "2026-11-1",
    "20261111",
    "2026-13-01",
    "2026-02-30",
    "2025-02-29",
    "2026-11-11T00:00:00Z",
    " 2026-11-11",
    "11/11/2026",
  ])("has no day for %j", (text) => {
    expect(dayOf(text)).toBeUndefined();
  });
});

describe("positions and paths", () => {
  it("splits a day into its chunk's key and its index there", () => {
    expect(position(20_768)).toEqual({ key: 5, index: 288 });
    expect(position(KEY_5)).toEqual({ key: 5, index: 0 });
    expect(position(KEY_5 - 1)).toEqual({ key: 4, index: 4095 });
    expect(position(0)).toEqual({ key: 0, index: 0 });
    expect(position(-1)).toEqual({ key: -1, index: 4095 });
  });

  it("names a chunk by its currency and key", () => {
    expect(chunkPath("USD", 5)).toBe("/USD-5");
    expect(chunkPath("DEM", -2)).toBe("/DEM--2");
  });
});
