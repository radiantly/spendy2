import { describe, expect, it } from "vitest";
import { columns } from "./columns.ts";
import { cellText, cellVersion, LOADING, loaderRowCount, MAX_ROWS } from "./loaderCells.ts";

const DATE = 0;
const ACCOUNT = 1;
const COUNTERPARTY = 2;
const CATEGORY = 3;
const AMOUNT = 4;
const REMARKS = 5;

/** What every cell of the loader's rows says after `steps`, row by row. */
const cellsAt = (steps: number) =>
  Array.from({ length: loaderRowCount(steps) }, (_, row) =>
    columns.map((_, column) => cellText(row, column, cellVersion(row, column, steps))),
  );

describe("loaderRowCount", () => {
  it("starts with a row, and adds one a step, up to the most it shows", () => {
    expect([0, 1, 50, MAX_ROWS - 1, MAX_ROWS, 10_000].map(loaderRowCount)).toEqual([
      1,
      2,
      51,
      MAX_ROWS,
      MAX_ROWS,
      MAX_ROWS,
    ]);
  });
});

describe("the loader's cells", () => {
  it("says the same each time for the same cell and step", () => {
    expect(cellsAt(500)).toEqual(cellsAt(500));
  });

  it("keeps most cells the same from one step to the next", () => {
    const [before, after] = [cellsAt(300).flat(), cellsAt(301).flat()];
    const changed = before.filter((text, at) => text !== after[at]).length;

    expect(changed).toBeLessThan(before.length / 20);
  });

  it("changes every cell now and then", () => {
    const [before, after] = [cellsAt(MAX_ROWS).flat(), cellsAt(MAX_ROWS + 1_000).flat()];
    const changed = before.filter((text, at) => text !== after[at]).length;

    // Some change back to what they were, or to "Loading" again.
    expect(changed).toBeGreaterThan(before.length / 2);
  });

  it("says Loading in some cells, about 1 in 5", () => {
    const cells = cellsAt(MAX_ROWS).flat();
    const loading = cells.filter((text) => text === LOADING).length;

    expect(loading).toBeGreaterThan(cells.length * 0.1);
    expect(loading).toBeLessThan(cells.length * 0.3);
  });

  it("makes up its names from random letters, not real words", () => {
    const rows = cellsAt(MAX_ROWS);
    for (const column of [ACCOUNT, COUNTERPARTY, CATEGORY, REMARKS]) {
      const names = rows.map((cells) => cells[column]!).filter((text) => text !== LOADING);

      for (const name of names) expect(name).toMatch(/^([A-Z][a-z]*( [A-Za-z]+)*)?$/);
      // Hardly any the same: they're not picked from a list.
      const named = names.filter((name) => name !== "");
      expect(new Set(named).size).toBeGreaterThan(named.length * 0.9);
    }
  });

  it("shows made-up data as the columns show theirs", () => {
    const rows = cellsAt(MAX_ROWS);
    const shown = (column: number) =>
      rows.map((cells) => cells[column]!).filter((text) => text !== LOADING);

    for (const date of shown(DATE)) expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const amount of shown(AMOUNT)) expect(amount).toMatch(/^\+?(\$|€|SGD\s)[\d,]+\.\d\d$/);
  });
});
