import { describe, expect, it } from "vitest";
import { defaultHighlight, menuItems, type MenuConfig } from "./menu.ts";

const accounts: MenuConfig = {
  options: ["Everyday Checking", "Rewards Credit Card", "Savings"],
  noMatch: "No account found",
};
const categories: MenuConfig = {
  options: ["Dining out", "Groceries", "Rent"],
  createLabel: (text) => `Create category “${text}”`,
  noMatch: "No category found",
};

const values = (config: MenuConfig, text: string, filtering = true) =>
  menuItems(config, text, filtering).map((item) => item.value);

describe("menuItems", () => {
  it("lists every option before the user types", () => {
    expect(values(accounts, "Savings", false)).toEqual([
      "Everyday Checking",
      "Rewards Credit Card",
      "Savings",
    ]);
  });

  it("lists every option for empty text", () => {
    expect(values(accounts, " ")).toHaveLength(3);
  });

  it("keeps the options containing the text, ignoring case", () => {
    expect(values(accounts, "CARD")).toEqual(["Rewards Credit Card"]);
    expect(values(accounts, "in")).toEqual(["Everyday Checking", "Savings"]);
  });

  it("puts an exact match first", () => {
    const config: MenuConfig = { options: ["Gas station", "Gas"], noMatch: "" };
    expect(values(config, "gas")).toEqual(["Gas", "Gas station"]);
  });

  it("lists nothing when nothing matches and nothing can be created", () => {
    expect(menuItems(accounts, "fdsafjsdoif", true)).toEqual([]);
  });

  it("offers to create the text, after the matches", () => {
    expect(menuItems(categories, " R ", true)).toEqual([
      { kind: "option", value: "Groceries" },
      { kind: "option", value: "Rent" },
      { kind: "create", value: "R", label: "Create category “R”" },
    ]);
  });

  it("doesn't offer to create an option that exists in other case", () => {
    expect(menuItems(categories, "rent", true)).toEqual([{ kind: "option", value: "Rent" }]);
  });
});

describe("defaultHighlight", () => {
  const highlight = (config: MenuConfig, text: string, filtering = true) =>
    defaultHighlight(menuItems(config, text, filtering), text, filtering);

  it("highlights the current value before the user types", () => {
    expect(highlight(accounts, "Savings", false)).toBe(2);
  });

  it("highlights the first match once the user types", () => {
    expect(highlight(categories, "Gro")).toBe(0);
  });

  it("highlights the create item when it's the only one", () => {
    expect(highlight(categories, "Pets")).toBe(0);
  });

  it("highlights nothing for empty text", () => {
    expect(highlight(categories, "")).toBe(-1);
  });

  it("highlights nothing when nothing matches", () => {
    expect(highlight(accounts, "fdsafjsdoif")).toBe(-1);
  });
});
