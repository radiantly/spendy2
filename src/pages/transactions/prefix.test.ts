import { describe, expect, it } from "vitest";
import { partFor, splitChange } from "./prefix.ts";

describe("partFor", () => {
  it.each(["E", "e", "é", "ж"])("gives the letter %j to the prefix", (character) => {
    expect(partFor(character)).toBe("prefix");
  });

  it.each(["1", "-", ".", ","])("gives %j to the text", (character) => {
    expect(partFor(character)).toBe("text");
  });

  it("gives a space to neither", () => {
    expect(partFor(" ")).toBeNull();
  });
});

describe("splitChange", () => {
  it("keeps a change of the part's own characters", () => {
    expect(splitChange("text", "12", "123", 3)).toEqual({
      value: "123",
      selection: [3, 3],
      other: "",
      switches: false,
    });
    expect(splitChange("prefix", "EU", "EUR", 3)).toEqual({
      value: "EUR",
      selection: [3, 3],
      other: "",
      switches: false,
    });
  });

  it("keeps a deletion", () => {
    expect(splitChange("text", "123", "13", 1)).toEqual({
      value: "13",
      selection: [1, 1],
      other: "",
      switches: false,
    });
  });

  it("switches to the other part on its character, keeping this one as it was", () => {
    expect(splitChange("text", "-1234.50", "-12E34.50", 4)).toEqual({
      value: "-1234.50",
      selection: [3, 3],
      other: "E",
      switches: true,
    });
    expect(splitChange("prefix", "SGD", "SGD1", 4)).toEqual({
      value: "SGD",
      selection: [3, 3],
      other: "1",
      switches: true,
    });
  });

  it("keeps the selection the other part's character was typed over", () => {
    expect(splitChange("text", "-1234.50", "U", 1)).toEqual({
      value: "-1234.50",
      selection: [0, 8],
      other: "U",
      switches: true,
    });
  });

  it("drops a space, staying in the part", () => {
    expect(splitChange("prefix", "EUR", "EUR ", 4)).toEqual({
      value: "EUR",
      selection: [3, 3],
      other: "",
      switches: false,
    });
    expect(splitChange("text", "5", "5 ", 2)).toEqual({
      value: "5",
      selection: [1, 1],
      other: "",
      switches: false,
    });
  });

  it("splits pasted text between the parts, staying in the part it ends with", () => {
    expect(splitChange("text", "-1234.50", "EUR 12.50", 9)).toEqual({
      value: "12.50",
      selection: [5, 5],
      other: "EUR",
      switches: false,
    });
    expect(splitChange("prefix", "USD", "12.50 EUR", 9)).toEqual({
      value: "EUR",
      selection: [3, 3],
      other: "12.50",
      switches: false,
    });
  });
});
