import { describe, expect, it } from "vitest";
import { categoryTree, listedIn, listedValues, namesIn } from "./categoryTree.ts";

const leaf = (name: string) => ({ name, children: [] });

describe("categoryTree", () => {
  it("puts each category under its parent, in the order listed", () => {
    expect(
      categoryTree([
        { name: "Dining out", parent: "Food" },
        { name: "Food", parent: null },
        { name: "Groceries", parent: "Food" },
        { name: "Rent", parent: null },
      ]),
    ).toEqual([{ name: "Food", children: [leaf("Dining out"), leaf("Groceries")] }, leaf("Rent")]);
  });

  it("nests subcategories of subcategories", () => {
    expect(
      categoryTree([
        { name: "Coffee", parent: "Dining out" },
        { name: "Dining out", parent: "Food" },
        { name: "Food", parent: null },
      ]),
    ).toEqual([{ name: "Food", children: [{ name: "Dining out", children: [leaf("Coffee")] }] }]);
  });

  it("leaves out categories in a loop of parents, which the schema prevents", () => {
    expect(
      categoryTree([
        { name: "A", parent: "B" },
        { name: "B", parent: "A" },
        { name: "Rent", parent: null },
      ]),
    ).toEqual([leaf("Rent")]);
  });
});

describe("namesIn", () => {
  it("gives the category's name and every one under it", () => {
    const [food] = categoryTree([
      { name: "Coffee", parent: "Dining out" },
      { name: "Dining out", parent: "Food" },
      { name: "Food", parent: null },
      { name: "Groceries", parent: "Food" },
    ]);

    expect(namesIn(food!)).toEqual(["Food", "Dining out", "Coffee", "Groceries"]);
  });
});

describe("listedIn and listedValues", () => {
  const tree = categoryTree([
    { name: "Food", parent: null },
    { name: "Groceries", parent: "Food" },
    { name: "Rent", parent: null },
  ]);

  it("lists categories without subcategories whether used or not", () => {
    expect(listedValues(tree, new Set())).toEqual(["Groceries", "Rent"]);
  });

  it("lists a category with subcategories, after them, only if it's used itself", () => {
    expect(listedIn(tree[0]!, new Set(["Food"]))).toEqual(["Groceries", "Food"]);
    expect(listedIn(tree[0]!, new Set(["Groceries"]))).toEqual(["Groceries"]);
  });

  it("lists no category last, if a transaction has none", () => {
    expect(listedValues(tree, new Set([null]))).toEqual(["Groceries", "Rent", null]);
  });
});
