import { useLayoutEffect, useRef } from "react";
import { useDatabase } from "../../db/useDatabase.ts";
import { useBreakpoint } from "../../hooks/useBreakpoint.ts";
import { useMediaQuery } from "../../hooks/useMediaQuery.ts";
import { TableMenuFace } from "./ColumnMenus.tsx";
import { columns } from "./columns.ts";
import { HeaderFace } from "./HeaderMenu.tsx";
import { cellText, cellVersion, loaderRowCount, MAX_ROWS, STEP } from "./loaderCells.ts";
import {
  Cell,
  CornerCell,
  HeaderCell,
  HeaderRow,
  RowNumberCell,
  TableFrame,
  TableHeader,
  TableRow,
  TransactionsFrame,
} from "./TableParts.tsx";
import { gridTemplate, ROW_HEIGHT } from "./tableLayout.ts";
import { DEFAULT_VIEW, sortedBy } from "./view.ts";

/**
 * Shows the loader's rows in `rows`, whose cells' texts are `texts` (by
 * row, then column), as far on as they are since the database began
 * opening at `openingSince`, then a step at a time, until the function it
 * returns stops it. Each step, only the cells due to change are changed.
 * With `still`, it shows all the rows at once, as they first are, and
 * leaves them.
 */
function play(rows: HTMLElement, texts: HTMLElement[][], openingSince: number, still: boolean) {
  // The version each cell shows, none yet.
  const versions = texts.map((cells) => cells.map(() => -1));
  const show = (count: number, steps: number) => {
    rows.style.height = `${count * ROW_HEIGHT}px`;
    texts.forEach((cells, row) =>
      cells.forEach((text, column) => {
        const version = cellVersion(row, column, steps);
        if (versions[row]![column] === version) return;
        versions[row]![column] = version;
        text.textContent = cellText(row, column, version);
      }),
    );
  };

  if (still) {
    show(MAX_ROWS, 0);
    return undefined;
  }
  let shownSteps = -1;
  let frame = 0;
  const showLatest = () => {
    const steps = Math.floor((performance.now() - openingSince) / STEP);
    if (steps !== shownSteps) show(loaderRowCount(steps), steps);
    shownSteps = steps;
    frame = requestAnimationFrame(showLatest);
  };
  showLatest();
  return () => cancelAnimationFrame(frame);
}

/**
 * Shown in place of the transactions while they load: while the database
 * opens, then while they're read from it. Where the table fits, it's the
 * page as the table shows it, with made-up transactions coming in (see
 * loaderCells.ts), all muted. It's as far on as the time since the database
 * began opening, so the loader shown while they're read carries on from
 * the one shown while it opened. Its row numbers have as much room as the
 * table's had when last opened or saved, so the table appears where it
 * was. Where reduced motion is preferred, its rows are all there at once,
 * and stay as they are. Screen readers hear `message`; where the table
 * doesn't fit, it's all that shows.
 */
function TransactionsLoader({ message }: { message: string }) {
  const { openingSince, rowNumberDigits } = useDatabase();
  const tableFits = useBreakpoint("md");
  const still = useMediaQuery("(prefers-reduced-motion: reduce)");
  const rowsRef = useRef<HTMLDivElement>(null);
  const textsRef = useRef<HTMLElement[][]>([]);
  // Unknown, as wide as its own.
  const template = gridTemplate(rowNumberDigits ?? String(MAX_ROWS).length);

  // React draws the rows once, their cells empty. What the cells say, and
  // how many of the rows show (their box's height), is up to `play` alone:
  // React never sets either, so the two never undo each other's. Laid out
  // before it's drawn, and again each time it's shown, having been hidden
  // (see AppShell's pages), whose effects stop meanwhile.
  useLayoutEffect(() => {
    if (!tableFits) return;
    return play(rowsRef.current!, textsRef.current, openingSince, still);
  }, [tableFits, openingSince, still]);

  if (!tableFits)
    return (
      <p role="status" className="m-auto text-sm text-ink-muted">
        {message}
      </p>
    );

  return (
    <TransactionsFrame withTable>
      <p role="status" className="sr-only">
        {message}
      </p>
      <TableFrame aria-hidden className="text-ink-muted">
        <TableHeader>
          <HeaderRow template={template}>
            <CornerCell>
              <TableMenuFace />
            </CornerCell>
            {columns.map(({ header, meta }) => (
              <HeaderCell key={String(header)}>
                <HeaderFace
                  label={String(header)}
                  sorted={sortedBy(DEFAULT_VIEW.sort, meta!.headerMenu)}
                  filtered={false}
                />
              </HeaderCell>
            ))}
          </HeaderRow>
        </TableHeader>
        <div ref={rowsRef} className="overflow-hidden">
          {Array.from({ length: MAX_ROWS }, (_, row) => (
            <TableRow key={row} template={template}>
              <RowNumberCell>{row + 1}</RowNumberCell>
              {columns.map(({ header, meta }, column) => (
                <Cell key={String(header)} align={meta!.align} tabular={meta!.tabular}>
                  <div
                    ref={(text) => {
                      if (text) (textsRef.current[row] ??= [])[column] = text;
                    }}
                    className="truncate"
                  />
                </Cell>
              ))}
            </TableRow>
          ))}
        </div>
      </TableFrame>
    </TransactionsFrame>
  );
}

export default TransactionsLoader;
