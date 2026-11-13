import { describe, expect, it } from "vitest";
import { conversionNote } from "./conversionNoteText.ts";

describe("conversionNote", () => {
  it("says how many were converted and how many left out", () => {
    expect(conversionNote(12, 3)).toBe(
      "12 foreign currency transactions automatically converted, 3 left out (missing conversions)",
    );
  });

  it("says only how many were converted when none were left out", () => {
    expect(conversionNote(12, 0)).toBe("12 foreign currency transactions automatically converted");
  });

  it("says only how many were left out when none were converted", () => {
    expect(conversionNote(0, 3)).toBe(
      "3 foreign currency transactions left out (missing conversions)",
    );
  });

  it("says nothing when neither happened", () => {
    expect(conversionNote(0, 0)).toBeNull();
  });

  it("counts one transaction as one", () => {
    expect(conversionNote(1, 1)).toBe(
      "1 foreign currency transaction automatically converted, 1 left out (missing conversions)",
    );
    expect(conversionNote(0, 1)).toBe(
      "1 foreign currency transaction left out (missing conversions)",
    );
  });

  it("groups the digits of large counts", () => {
    expect(conversionNote(12_345, 1000)).toBe(
      "12,345 foreign currency transactions automatically converted, 1,000 left out (missing conversions)",
    );
  });
});
