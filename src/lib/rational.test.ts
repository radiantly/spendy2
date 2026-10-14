import { describe, expect, it } from "vitest";
import { reduce, toDecimalString, toNumber } from "./rational.ts";

describe("reduce", () => {
  it.each([
    [6, 4, 3, 2],
    [-6, 4, -3, 2],
    [6, -4, -3, 2],
    [-6, -4, 3, 2],
    [0, 7, 0, 1],
    [0, -7, 0, 1],
    [5, 1, 5, 1],
  ])("reduces %i/%i to %i/%i", (numerator, denominator, n, d) => {
    expect(reduce(numerator, denominator)).toEqual({ numerator: n, denominator: d });
  });

  it("never gives a negative zero", () => {
    expect(Object.is(reduce(-0, 5)!.numerator, 0)).toBe(true);
    expect(Object.is(reduce(0, -5)!.numerator, 0)).toBe(true);
  });

  it.each([
    [1, 0],
    [1.5, 2],
    [1, 0.5],
    [Number.MAX_SAFE_INTEGER + 1, 1],
    [1, -(Number.MAX_SAFE_INTEGER + 1)],
    [Number.NaN, 1],
  ])("rejects %d/%d", (numerator, denominator) => {
    expect(reduce(numerator, denominator)).toBeNull();
  });
});

describe("toNumber", () => {
  it("divides", () => {
    expect(toNumber({ numerator: -5, denominator: 4 })).toBe(-1.25);
  });
});

describe("toDecimalString", () => {
  it.each([
    [1, 3, 4, "0.3333"],
    [-4, 3, 3, "-1.333"],
    [2, 3, 2, "0.66"],
    [201, 200, 3, "1.005"],
    [-1, 300, 2, "-0.00"],
    [7, 1, 0, "7"],
    [-7, 2, 0, "-3"],
    [5, 1, 2, "5.00"],
  ])("cuts %i/%i off after %i places as %s", (numerator, denominator, digits, expected) => {
    expect(toDecimalString({ numerator, denominator }, digits)).toBe(expected);
  });

  it("is exact past what a float can hold", () => {
    expect(toDecimalString({ numerator: Number.MAX_SAFE_INTEGER, denominator: 3 }, 5)).toBe(
      "3002399751580330.33333",
    );
  });

  it("works with a denominator near the largest safe integer", () => {
    expect(toDecimalString({ numerator: 1, denominator: Number.MAX_SAFE_INTEGER }, 20)).toBe(
      "0.00000000000000011102",
    );
  });
});
