import { describe, expect, it } from "vitest";
import { chunkOf } from "../../test/rates.ts";
import { convert, fill, lastRate, rateAt, startsWithout } from "./reader.ts";

/** No rate that day. */
const NONE = NaN;

describe("fill", () => {
  it("keeps a day's own rate", () => {
    expect([...fill(chunkOf(1.15, 1.16, 1.17), NONE)]).toEqual([1.15, 1.16, 1.17]);
  });

  it("reads a rate as a little-endian float64", () => {
    // 1.5 is 0x3FF8000000000000.
    const chunk = Uint8Array.of(0, 0, 0, 0, 0, 0, 0xf8, 0x3f).buffer;
    expect([...fill(chunk, NONE)]).toEqual([1.5]);
  });

  it("gives a day without a rate the last before it", () => {
    // A Friday, a weekend, a Monday, a holiday.
    expect([...fill(chunkOf(1.15, NONE, NONE, 1.18, NONE), NONE)]).toEqual([
      1.15, 1.15, 1.15, 1.18, 1.18,
    ]);
  });

  it("gives the days before the chunk's first rate the one in force as it starts", () => {
    expect([...fill(chunkOf(NONE, NONE, 1.17, NONE), 1.11)]).toEqual([1.11, 1.11, 1.17, 1.17]);
  });

  it("leaves the days before the first rate without one when none was in force", () => {
    expect([...fill(chunkOf(NONE, NONE, 1.17), NONE)]).toEqual([NONE, NONE, 1.17]);
  });

  it("never gives a day a later rate", () => {
    const filled = fill(chunkOf(NONE, 2, NONE, 3), NONE);
    expect([...filled]).toEqual([NONE, 2, 2, 3]);
  });

  it("takes a chunk's own first rate over the one in force before it", () => {
    expect([...fill(chunkOf(1.2, NONE), 1.11)]).toEqual([1.2, 1.2]);
  });

  it("is a single day of the rate in force for a chunk there isn't, or an empty one", () => {
    expect([...fill(null, 42)]).toEqual([42]);
    expect([...fill(chunkOf(), 42)]).toEqual([42]);
    expect([...fill(null, NONE)]).toEqual([NONE]);
    expect([...fill(chunkOf(), NONE)]).toEqual([NONE]);
  });

  it("is of the rate in force throughout for a chunk without a rate", () => {
    expect([...fill(chunkOf(NONE, NONE), 42)]).toEqual([42, 42]);
    expect([...fill(chunkOf(NONE, NONE), NONE)]).toEqual([NONE, NONE]);
  });

  it("leaves out the bytes of a rate cut short", () => {
    const whole = chunkOf(1.15, 1.16);
    expect([...fill(whole.slice(0, 12), NONE)]).toEqual([1.15]);
    expect([...fill(whole.slice(0, 7), 42)]).toEqual([42]);
  });

  it("fills a full chunk, as long as its days", () => {
    const rates = Array.from({ length: 4096 }, (_, index) => (index % 7 < 5 ? index + 1 : NONE));
    const filled = fill(chunkOf(...rates), NONE);
    expect(filled).toHaveLength(4096);
    expect(filled[4]).toBe(5);
    expect(filled[5]).toBe(5);
    expect(filled[6]).toBe(5);
    expect(filled[7]).toBe(8);
    expect(filled[4095]).toBe(4096);
  });

  it("leaves the chunk it was given alone", () => {
    const chunk = chunkOf(1.15, NONE);
    const before = new Uint8Array(chunk.slice(0));
    fill(chunk, 1);
    expect(new Uint8Array(chunk)).toEqual(before);
  });
});

describe("rateAt", () => {
  const filled = fill(chunkOf(NONE, 1.15, NONE, 1.17), NONE);

  it("is the rate in force on a day of the chunk", () => {
    expect(rateAt(filled, 1)).toBe(1.15);
    expect(rateAt(filled, 2)).toBe(1.15);
    expect(rateAt(filled, 3)).toBe(1.17);
  });

  it("is NaN for a day before the first rate", () => {
    expect(rateAt(filled, 0)).toBeNaN();
  });

  it("is the chunk's last rate for a day after its end", () => {
    expect(rateAt(filled, 4)).toBe(1.17);
    expect(rateAt(filled, 4095)).toBe(1.17);
  });

  it("is the rate in force for any day of a chunk there isn't", () => {
    expect(rateAt(fill(null, 42), 0)).toBe(42);
    expect(rateAt(fill(null, 42), 4095)).toBe(42);
    expect(rateAt(fill(null, NONE), 0)).toBeNaN();
  });
});

describe("lastRate", () => {
  it("is the chunk's last day's with a rate", () => {
    expect(lastRate(chunkOf(1.15, 1.16))).toBe(1.16);
    expect(lastRate(chunkOf(1.15, 1.16, NONE, NONE))).toBe(1.16);
  });

  it("is NaN for a chunk without a rate", () => {
    expect(lastRate(chunkOf())).toBeNaN();
    expect(lastRate(chunkOf(NONE, NONE))).toBeNaN();
    expect(lastRate(chunkOf(1.15).slice(0, 7))).toBeNaN();
  });
});

describe("startsWithout", () => {
  it("is whether the chunk's first day has no rate", () => {
    expect(startsWithout(chunkOf(1.15, NONE))).toBe(false);
    expect(startsWithout(chunkOf(NONE, 1.15))).toBe(true);
    expect(startsWithout(chunkOf())).toBe(true);
    expect(startsWithout(chunkOf(1.15).slice(0, 7))).toBe(true);
  });
});

describe("convert", () => {
  it("is the amount in the other currency, from each one's rate to the euro", () => {
    // A euro bought 1.25 dollars and 0.8 pounds: a dollar is 0.64 pounds.
    expect(convert(100, 1.25, 0.8)).toBe(64);
    expect(convert(64, 0.8, 1.25)).toBe(100);
  });

  it("takes 1 as the euro's rate", () => {
    expect(convert(100, 1.25, 1)).toBe(80);
    expect(convert(80, 1, 1.25)).toBe(100);
  });

  it("leaves an amount in its own currency as it is", () => {
    expect(convert(123.45, 1.17, 1.17)).toBe(123.45);
    // Amounts and rates that multiplying before dividing would not give back.
    for (let cents = 1; cents <= 2000; cents++)
      for (const rate of [0.0073, 1.17, 3.3, 151.42, 16_870.5])
        expect(convert(cents / 100, rate, rate)).toBe(cents / 100);
  });

  it("keeps the amount's sign", () => {
    expect(convert(-100, 1.25, 0.8)).toBe(-64);
    expect(convert(0, 1.25, 0.8)).toBe(0);
  });
});
