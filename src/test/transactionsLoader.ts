/*
 * The transactions' loader (see TransactionsLoader), as tests see it: what
 * it says it waits for, and its made-up table, which screen readers don't.
 */

import { page } from "vitest/browser";
import { ROW_HEIGHT } from "../pages/transactions/tableLayout.ts";

/** What the loader says it waits for: screen readers hear it in place of its rows. */
export const loaderStatus = () =>
  page.getByRole("status").filter({ hasText: /^(Opening your database|Loading transactions)…$/ });

/** The loader's made-up table, after its status, or null without one. */
export const loaderTable = () => loaderStatus().query()?.nextElementSibling ?? null;

/** The table's header and the box its rows come into. */
function loaderParts() {
  const [header, rows] = loaderTable()!.children;
  return { headerRow: header!.firstElementChild!, rows: rows! };
}

/** The cells of the loader's header, the corner first. */
export const loaderHeaderCells = () => [...loaderParts().headerRow.children];

/** The box the loader's rows come into, growing a row at a time. */
export const loaderRowsBox = () => loaderParts().rows;

/** The loader's rows, shown or not. */
export const loaderRows = () => [...loaderRowsBox().children];

/** How many rows the loader shows, as far as the box they come into has grown; none without it. */
export function loaderShownRows() {
  if (!loaderTable()) return 0;
  return Math.round(loaderRowsBox().getBoundingClientRect().height / ROW_HEIGHT);
}

/** What the loader's shown rows say: each one's number, then its cells'. */
export const loaderTexts = () =>
  loaderRows()
    .slice(0, loaderShownRows())
    .map((row) => [...row.children].map((cell) => cell.textContent));
