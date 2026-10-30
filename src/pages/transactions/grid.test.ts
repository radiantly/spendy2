import { describe, expect, it } from "vitest";
import {
  bounds,
  cellAtPoint,
  clampSelection,
  collapsed,
  contains,
  covering,
  extend,
  isRange,
  move,
  rowsCovered,
  tab,
  target,
  type Direction,
  type GridLayout,
  type Motion,
} from "./grid.ts";

const SIZE = { rows: 10, columns: 4 };
const at = (row: number, column: number) => ({ row, column });
const step = (direction: Direction): Motion => ({ kind: "step", direction });

describe("move", () => {
  it("moves the active cell one step", () => {
    expect(move(collapsed(at(2, 1)), step("down"), SIZE)).toEqual(collapsed(at(3, 1)));
    expect(move(collapsed(at(2, 1)), step("up"), SIZE)).toEqual(collapsed(at(1, 1)));
    expect(move(collapsed(at(2, 1)), step("left"), SIZE)).toEqual(collapsed(at(2, 0)));
    expect(move(collapsed(at(2, 1)), step("right"), SIZE)).toEqual(collapsed(at(2, 2)));
  });

  it("stops at the edges", () => {
    expect(move(collapsed(at(0, 0)), step("up"), SIZE)).toEqual(collapsed(at(0, 0)));
    expect(move(collapsed(at(0, 0)), step("left"), SIZE)).toEqual(collapsed(at(0, 0)));
    expect(move(collapsed(at(9, 3)), step("down"), SIZE)).toEqual(collapsed(at(9, 3)));
    expect(move(collapsed(at(9, 3)), step("right"), SIZE)).toEqual(collapsed(at(9, 3)));
  });

  it("drops a range, moving from the active cell rather than the head", () => {
    expect(move({ active: at(2, 1), head: at(5, 3) }, step("down"), SIZE)).toEqual(
      collapsed(at(3, 1)),
    );
  });
});

describe("target", () => {
  const from = at(4, 1);

  it("jumps to the grid's edge with Ctrl+arrows", () => {
    expect(target(from, { kind: "edge", direction: "up" }, SIZE)).toEqual(at(0, 1));
    expect(target(from, { kind: "edge", direction: "down" }, SIZE)).toEqual(at(9, 1));
    expect(target(from, { kind: "edge", direction: "left" }, SIZE)).toEqual(at(4, 0));
    expect(target(from, { kind: "edge", direction: "right" }, SIZE)).toEqual(at(4, 3));
  });

  it("moves a page of rows, stopping at the edges", () => {
    expect(target(from, { kind: "rows", count: 3 }, SIZE)).toEqual(at(7, 1));
    expect(target(from, { kind: "rows", count: -3 }, SIZE)).toEqual(at(1, 1));
    expect(target(from, { kind: "rows", count: 30 }, SIZE)).toEqual(at(9, 1));
    expect(target(from, { kind: "rows", count: -30 }, SIZE)).toEqual(at(0, 1));
  });

  it("goes to the start or end of the row with Home and End", () => {
    expect(target(from, { kind: "rowStart" }, SIZE)).toEqual(at(4, 0));
    expect(target(from, { kind: "rowEnd" }, SIZE)).toEqual(at(4, 3));
  });

  it("goes to the grid's first or last cell with Ctrl+Home and Ctrl+End", () => {
    expect(target(from, { kind: "gridStart" }, SIZE)).toEqual(at(0, 0));
    expect(target(from, { kind: "gridEnd" }, SIZE)).toEqual(at(9, 3));
  });
});

describe("tab", () => {
  it("moves along the row", () => {
    expect(tab(collapsed(at(2, 1)), false, SIZE)).toEqual(collapsed(at(2, 2)));
    expect(tab(collapsed(at(2, 1)), true, SIZE)).toEqual(collapsed(at(2, 0)));
  });

  it("wraps from the end of a row to the start of the next, and back", () => {
    expect(tab(collapsed(at(2, 3)), false, SIZE)).toEqual(collapsed(at(3, 0)));
    expect(tab(collapsed(at(3, 0)), true, SIZE)).toEqual(collapsed(at(2, 3)));
  });

  it("stops at the grid's first and last cell", () => {
    expect(tab(collapsed(at(0, 0)), true, SIZE)).toEqual(collapsed(at(0, 0)));
    expect(tab(collapsed(at(9, 3)), false, SIZE)).toEqual(collapsed(at(9, 3)));
  });

  it("drops a range, moving from the active cell", () => {
    expect(tab({ active: at(2, 1), head: at(5, 3) }, false, SIZE)).toEqual(collapsed(at(2, 2)));
  });
});

describe("clampSelection", () => {
  it("keeps a selection that fits", () => {
    const selection = { active: at(2, 1), head: at(5, 3) };
    expect(clampSelection(selection, SIZE)).toBe(selection);
  });

  it("moves cells past the last row or column onto it", () => {
    expect(clampSelection({ active: at(12, 1), head: at(3, 6) }, SIZE)).toEqual({
      active: at(9, 1),
      head: at(3, 3),
    });
  });

  it("selects nothing in a grid without cells", () => {
    expect(clampSelection(collapsed(at(0, 0)), { rows: 0, columns: 4 })).toBeNull();
  });
});

describe("extend", () => {
  it("moves the head and keeps the active cell", () => {
    const once = extend(collapsed(at(2, 1)), step("down"), SIZE);
    expect(once).toEqual({ active: at(2, 1), head: at(3, 1) });
    expect(extend(once, step("right"), SIZE)).toEqual({ active: at(2, 1), head: at(3, 2) });
  });

  it("can shrink back to the active cell", () => {
    const selection = extend(extend(collapsed(at(2, 1)), step("down"), SIZE), step("up"), SIZE);
    expect(isRange(selection)).toBe(false);
  });

  it("stops at the edges", () => {
    expect(extend(collapsed(at(0, 0)), step("up"), SIZE)).toEqual(collapsed(at(0, 0)));
  });
});

describe("bounds", () => {
  it("covers the cells between the active cell and the head, whichever way round", () => {
    const expected = { top: 1, bottom: 4, left: 0, right: 2 };
    expect(bounds({ active: at(1, 0), head: at(4, 2) })).toEqual(expected);
    expect(bounds({ active: at(4, 2), head: at(1, 0) })).toEqual(expected);
    expect(bounds({ active: at(1, 2), head: at(4, 0) })).toEqual(expected);
  });

  it("gives the rows a selection covers, top to bottom, whichever way round", () => {
    expect(rowsCovered({ active: at(4, 2), head: at(2, 0) })).toEqual([2, 3, 4]);
    expect(rowsCovered(collapsed(at(3, 1)))).toEqual([3]);
  });

  it("knows which cells it contains", () => {
    const area = bounds({ active: at(1, 0), head: at(4, 2) });

    expect(contains(area, at(1, 0))).toBe(true);
    expect(contains(area, at(4, 2))).toBe(true);
    expect(contains(area, at(5, 2))).toBe(false);
    expect(contains(area, at(2, 3))).toBe(false);
  });
});

describe("covering", () => {
  it("is null for no cells", () => {
    expect(covering([])).toBeNull();
  });

  it("is just the cell for one", () => {
    expect(covering([at(3, 2)])).toEqual(collapsed(at(3, 2)));
  });

  it("spans the cells, active at the top left, in any order", () => {
    expect(covering([at(4, 1), at(2, 3), at(5, 2)])).toEqual({
      active: at(2, 1),
      head: at(5, 3),
    });
  });

  it("handles more cells than a function takes arguments", () => {
    const cells = Array.from({ length: 500_000 }, (_, row) => at(row, row % 3));

    expect(covering(cells)).toEqual({ active: at(0, 0), head: at(499_999, 2) });
  });
});

describe("cellAtPoint", () => {
  // Rows start at y=100, 20px each; columns at x=10, 60, 110, 200.
  const layout: GridLayout = { top: 100, rowHeight: 20, columnLefts: [10, 60, 110, 200] };

  it("finds the cell under the point", () => {
    expect(cellAtPoint(layout, SIZE, 10, 100)).toEqual(at(0, 0));
    expect(cellAtPoint(layout, SIZE, 59, 119)).toEqual(at(0, 0));
    expect(cellAtPoint(layout, SIZE, 60, 120)).toEqual(at(1, 1));
    expect(cellAtPoint(layout, SIZE, 250, 175)).toEqual(at(3, 3));
  });

  it("counts a point outside the grid as the nearest cell", () => {
    expect(cellAtPoint(layout, SIZE, 0, 0)).toEqual(at(0, 0));
    expect(cellAtPoint(layout, SIZE, 5000, 5000)).toEqual(at(9, 3));
    expect(cellAtPoint(layout, SIZE, 80, 50)).toEqual(at(0, 1));
  });
});
