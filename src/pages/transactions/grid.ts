/**
 * The spreadsheet selection: an active cell, and a range from it to a second
 * cell, the head. Keys on their own move the active cell; with Shift, and
 * dragging, they move the head, so the active cell stays where the range
 * started.
 */

export type CellPosition = { row: number; column: number };

export type GridSelection = { active: CellPosition; head: CellPosition };

export type GridSize = { rows: number; columns: number };

export type Direction = "up" | "down" | "left" | "right";

/** The cells a selection covers, inclusive. */
export type Bounds = { top: number; bottom: number; left: number; right: number };

/**
 * Where a key moves to: one cell (arrows), to the grid's edge (Ctrl+arrows),
 * a number of rows (Page Up and Down), the row's first or last cell (Home,
 * End), or the grid's first or last cell (Ctrl+Home, Ctrl+End).
 */
export type Motion =
  | { kind: "step" | "edge"; direction: Direction }
  | { kind: "rows"; count: number }
  | { kind: "rowStart" | "rowEnd" | "gridStart" | "gridEnd" };

const STEPS: Record<Direction, CellPosition> = {
  up: { row: -1, column: 0 },
  down: { row: 1, column: 0 },
  left: { row: 0, column: -1 },
  right: { row: 0, column: 1 },
};

export function samePosition(a: CellPosition, b: CellPosition) {
  return a.row === b.row && a.column === b.column;
}

/** Just `cell`, with no range. */
export function collapsed(cell: CellPosition): GridSelection {
  return { active: cell, head: cell };
}

export function isRange(selection: GridSelection) {
  return !samePosition(selection.active, selection.head);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function clampPosition(cell: CellPosition, size: GridSize): CellPosition {
  return {
    row: clamp(cell.row, 0, size.rows - 1),
    column: clamp(cell.column, 0, size.columns - 1),
  };
}

/**
 * `selection` within a grid of `size`, which may have shrunk since it was
 * made: cells past the edges move onto them. Null when there are no cells.
 */
export function clampSelection(selection: GridSelection, size: GridSize): GridSelection | null {
  if (size.rows === 0 || size.columns === 0) return null;
  const active = clampPosition(selection.active, size);
  const head = clampPosition(selection.head, size);
  return samePosition(active, selection.active) && samePosition(head, selection.head)
    ? selection
    : { active, head };
}

/** Where `motion` goes from `cell`. Stops at the edges. */
export function target(cell: CellPosition, motion: Motion, size: GridSize): CellPosition {
  const last = { row: size.rows - 1, column: size.columns - 1 };
  switch (motion.kind) {
    case "step": {
      const delta = STEPS[motion.direction];
      return clampPosition({ row: cell.row + delta.row, column: cell.column + delta.column }, size);
    }
    case "edge": {
      const delta = STEPS[motion.direction];
      return clampPosition(
        {
          row: cell.row + delta.row * size.rows,
          column: cell.column + delta.column * size.columns,
        },
        size,
      );
    }
    case "rows":
      return clampPosition({ row: cell.row + motion.count, column: cell.column }, size);
    case "rowStart":
      return { row: cell.row, column: 0 };
    case "rowEnd":
      return { row: cell.row, column: last.column };
    case "gridStart":
      return { row: 0, column: 0 };
    case "gridEnd":
      return last;
  }
}

/** Moves the active cell, dropping any range. */
export function move(selection: GridSelection, motion: Motion, size: GridSize) {
  return collapsed(target(selection.active, motion, size));
}

/** Moves the range's head, keeping the active cell. */
export function extend(selection: GridSelection, motion: Motion, size: GridSize) {
  return { active: selection.active, head: target(selection.head, motion, size) };
}

/**
 * Where Tab moves the active cell, dropping any range: to the next cell,
 * or from the end of a row to the start of the next one. Shift+Tab goes
 * back the same way. Stops at the grid's first and last cell.
 */
export function tab(selection: GridSelection, backward: boolean, size: GridSize) {
  const index = selection.active.row * size.columns + selection.active.column;
  const next = clamp(index + (backward ? -1 : 1), 0, size.rows * size.columns - 1);
  return collapsed({ row: Math.floor(next / size.columns), column: next % size.columns });
}

export function bounds({ active, head }: GridSelection): Bounds {
  return {
    top: Math.min(active.row, head.row),
    bottom: Math.max(active.row, head.row),
    left: Math.min(active.column, head.column),
    right: Math.max(active.column, head.column),
  };
}

/** The indexes of the rows `selection` covers, top to bottom. */
export function rowsCovered(selection: GridSelection): number[] {
  const { top, bottom } = bounds(selection);
  return Array.from({ length: bottom - top + 1 }, (_, index) => top + index);
}

/** The smallest selection covering every one of `cells`, active at its top left. */
export function covering(cells: readonly CellPosition[]): GridSelection | null {
  const [first] = cells;
  if (first === undefined) return null;
  const area = { top: first.row, bottom: first.row, left: first.column, right: first.column };
  // Not Math.min(...): a whole column cleared is more cells than it takes arguments.
  for (const { row, column } of cells) {
    area.top = Math.min(area.top, row);
    area.bottom = Math.max(area.bottom, row);
    area.left = Math.min(area.left, column);
    area.right = Math.max(area.right, column);
  }
  return {
    active: { row: area.top, column: area.left },
    head: { row: area.bottom, column: area.right },
  };
}

export function contains(area: Bounds, cell: CellPosition) {
  return (
    cell.row >= area.top &&
    cell.row <= area.bottom &&
    cell.column >= area.left &&
    cell.column <= area.right
  );
}

/**
 * Where the grid's cells are on screen, in viewport coordinates: the top of
 * the first row, the row height, and each column's left edge.
 */
export type GridLayout = { top: number; rowHeight: number; columnLefts: readonly number[] };

/**
 * The cell under a viewport point. A point outside the grid counts as the
 * nearest cell, so a drag past an edge keeps selecting along it.
 */
export function cellAtPoint(layout: GridLayout, size: GridSize, x: number, y: number) {
  let column = 0;
  while (column + 1 < layout.columnLefts.length && x >= layout.columnLefts[column + 1]!) column++;
  const row = Math.floor((y - layout.top) / layout.rowHeight);
  return clampPosition({ row, column }, size);
}
