/**
 * The transactions' table's sizes and tracks, which its loader (see
 * TransactionsLoader) is laid out by too, so the table appears where the
 * loader was.
 */

import { columns } from "./columns.ts";

/** Rows have a fixed height, so the virtualizer never has to measure them. */
export const ROW_HEIGHT = 28;
/** A row and the line above it, so the header has the same space inside as a row. */
export const HEADER_HEIGHT = ROW_HEIGHT + 1;

const COLUMN_TRACKS = columns.map((column) => column.meta!.track).join(" ");

/**
 * The table's grid tracks: the row numbers' first, as wide as `digits` of
 * them (tabular, so a `ch` each) with the cell's padding and line, then the
 * columns'.
 */
export function gridTemplate(digits: number) {
  return `calc(${digits}ch + 1rem + 1px) ${COLUMN_TRACKS}`;
}
