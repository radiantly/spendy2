import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useTable } from "@tanstack/react-table";
import { defaultRangeExtractor, useWindowVirtualizer, type Range } from "@tanstack/react-virtual";
import type { Moved } from "../../db/editHistory.ts";
import type { Edit } from "../../db/databaseContext.ts";
import {
  hasPatch,
  type TransactionPatch,
  type TransactionRow,
} from "../../db/queries/transactions.ts";
import type { HistoryDirection } from "../../lib/historyKey.ts";
import { columns, features, type CellEditor } from "./columns.ts";
import { selectBetween, selectionAnchor, textOffsetAtPoint, wordAt } from "./caret.ts";
import EditableCell, { type FinishHow, type SubmitResult } from "./EditableCell.tsx";
import {
  bounds,
  cellAtPoint,
  clampSelection,
  collapsed,
  contains,
  covering,
  edges,
  extend,
  isRange,
  move,
  samePosition,
  tab,
  type Bounds,
  type CellPosition,
  type Direction,
  type GridSelection,
  type Motion,
} from "./grid.ts";
import type { HeaderMenuHandle, HeaderProps } from "./HeaderMenu.tsx";
import { useMouseDrag, type Point } from "./useMouseDrag.ts";
import type { MenuColumn, Sort } from "./view.ts";

/** Rows have a fixed height, so the virtualizer never has to measure them. */
export const ROW_HEIGHT = 28;
/** A row and the line above it, so the header has the same space inside as a row. */
export const HEADER_HEIGHT = ROW_HEIGHT + 1;

const GRID_TEMPLATE = columns.map((column) => column.meta!.track).join(" ");

const ARROWS: Record<string, Direction> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

/**
 * Where a key moves the selection, if it's a movement key. Ctrl (or Cmd)
 * with an arrow jumps to the grid's edge; with Home or End, to its first
 * or last cell. `pageRows` is how far Page Up and Page Down go.
 */
function motionFor(event: KeyboardEvent, pageRows: number): Motion | null {
  const jump = event.ctrlKey || event.metaKey;
  const direction = ARROWS[event.key];
  if (direction) return { kind: jump ? "edge" : "step", direction };
  if (event.key === "Home") return { kind: jump ? "gridStart" : "rowStart" };
  if (event.key === "End") return { kind: jump ? "gridEnd" : "rowEnd" };
  if (event.key === "PageUp") return { kind: "rows", count: -pageRows };
  if (event.key === "PageDown") return { kind: "rows", count: pageRows };
  return null;
}

type Editing = {
  cell: CellPosition;
  /** Replaces the cell's text, when the edit was started by typing it. */
  text?: string;
  caret: number;
};

/** A press on a cell, followed until the mouse button is released. */
type Drag = {
  /** The cell the range starts from; the pointer back over it selects just it. */
  origin: CellPosition;
  /**
   * Where text selection started in the origin cell's input, to select from
   * while the pointer is over that cell. Null when the press doesn't select
   * text (it wasn't an edit, or it selected a word or everything).
   */
  textAnchor: number | null;
  /** Whether the pointer is over another cell, selecting a range. */
  ranging: boolean;
};

/**
 * A field to set on a transaction, as the columns it sets: `rowIndex` is
 * the transaction's position in `rows`.
 */
export type TransactionChange = {
  rowIndex: number;
  field: CellEditor["field"];
  patch: TransactionPatch;
};

const editorOf = (column: number): CellEditor | undefined => columns[column]!.meta!.editor;

const columnOf = (field: CellEditor["field"]) =>
  columns.findIndex((column) => column.meta!.editor?.field === field);

type TransactionsTableProps = {
  rows: TransactionRow[];
  categories: readonly string[];
  accounts: readonly string[];
  /** Changes to store; several at once when a range is cleared. */
  onCommit: (changes: TransactionChange[]) => void;
  /** Called when a cell starts being edited, and when it stops. */
  onEditingChange?: (editing: boolean) => void;
  /**
   * The latest undo or redo. Each new one selects the cells it changed, so
   * it's clear what did (once the table is shown, if it's hidden).
   */
  lastUndoOrRedo: Moved<Edit> | null;
  /** Undo or redo asked for from a cell being edited (see EditableCell). */
  onUndoOrRedo: (direction: HistoryDirection) => void;
  /**
   * The headers' menus, for sorting and filtering by their columns (see the
   * columns' `headerMenu`): `sort` is how the rows are sorted, and `render`
   * renders a header's menu. Without, the headers are plain labels.
   */
  menus?: {
    sort: Sort;
    render: (column: MenuColumn, header: HeaderProps) => ReactNode;
  };
};

/**
 * Every transaction on one long page, as a spreadsheet: one cell is active,
 * a range of cells can be selected from it, and a cell turns into an input
 * as soon as it's pressed. Only the rows in (and near) the viewport are
 * rendered; the page scrolls as if all of them were there.
 */
function TransactionsTable({
  rows,
  categories,
  accounts,
  onCommit,
  onEditingChange,
  lastUndoOrRedo,
  onUndoOrRedo,
  menus,
}: TransactionsTableProps) {
  // The table and virtualizer are mutable objects that return new results
  // from the same instance, so the React Compiler would memoize reads of
  // them and render stale rows. They are only read here, so opting this
  // component out keeps the rest of the app compiled.
  "use no memo";

  // Only its columns and headers are read: the rows are drawn straight from
  // `rows`, as building its row model for every transaction took about as
  // long as sorting them, on each change of the rows (an edit too).
  const table = useTable({ features, columns, data: rows });
  const leafColumns = table.getAllLeafColumns();
  const size = { rows: rows.length, columns: columns.length };
  // The rows can change under the selection, so it's kept to the cells there are.
  const [unclamped, setSelection] = useState<GridSelection | null>(null);
  const selection = unclamped && clampSelection(unclamped, size);
  const [editing, setEditing] = useState<Editing | null>(null);
  const isEditing = editing !== null;
  // Before the browser can run anything else, so a parent holding something
  // back during edits does so from the press that starts one.
  useLayoutEffect(() => {
    if (!isEditing) return;
    onEditingChange?.(true);
    // Also when the table goes away mid-edit.
    return () => onEditingChange?.(false);
  }, [isEditing, onEditingChange]);
  // The column whose header is active, while no cell is: from the keyboard,
  // Up from the first row reaches the headers, where their menus open.
  const [headerColumn, setHeaderColumn] = useState<number | null>(null);
  const activeHeader = selection === null ? headerColumn : null;
  const gridId = useId();
  const cellId = (cell: CellPosition) => `${gridId}-${cell.row}-${cell.column}`;
  const headerId = (column: number) => `${gridId}-header-${column}`;

  const gridRef = useRef<HTMLDivElement>(null);
  const headerRowRef = useRef<HTMLDivElement>(null);
  // The input of the cell being edited.
  const inputRef = useRef<HTMLInputElement>(null);
  // The menus of the headers with them, by column.
  const menusRef = useRef<(HeaderMenuHandle | null)[]>([]);
  const dragRef = useRef<Drag | null>(null);

  // The virtualizer measures scroll positions from the top of the page; it
  // needs to know where the rows start.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    setScrollMargin(bodyRef.current!.getBoundingClientRect().top + window.scrollY);
  }, []);

  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    scrollMargin,
    // Scrolling a row into view stops below the sticky header.
    scrollPaddingStart: HEADER_HEIGHT,
    // Keep the active cell's row rendered when it scrolls out of view, so
    // the grid can still point at the cell, and the input of an edit in it
    // (always the active cell) isn't thrown away. In order, so its row is
    // never moved in the DOM: that would blur the input, and React's
    // focusing it again makes Firefox scroll back to it.
    rangeExtractor: (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      if (selection && !indexes.includes(selection.active.row)) indexes.push(selection.active.row);
      return indexes.sort((a, b) => a - b);
    },
  });

  function focusGrid() {
    gridRef.current!.focus({ preventScroll: true });
  }

  /** How many rows Page Up and Page Down move: as many as fit below the header. */
  function pageRows() {
    return Math.max(
      1,
      Math.floor((document.documentElement.clientHeight - HEADER_HEIGHT) / ROW_HEIGHT),
    );
  }

  /**
   * Scrolls the page so `cell` is in view, rendered or not. With `rows`, it
   * first scrolls that many rows, as Page Up and Page Down do, so the cell
   * stays where it was on screen.
   */
  function reveal(cell: CellPosition, rows = 0) {
    const offset = (virtualizer.scrollOffset ?? window.scrollY) + rows * ROW_HEIGHT;
    const top = scrollMargin + cell.row * ROW_HEIGHT;
    const visible =
      top >= offset + HEADER_HEIGHT &&
      top + ROW_HEIGHT <= offset + document.documentElement.clientHeight;
    if (rows !== 0 && visible) virtualizer.scrollToOffset(offset);
    else virtualizer.scrollToIndex(cell.row, { align: "auto" });
    revealColumn(cell.column);
  }

  /** Scrolls the page sideways, if it has to, so `column` is in view. */
  function revealColumn(column: number) {
    // The header cells are always rendered, and line up with the column's.
    const box = headerRowRef.current!.children[column]!.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    if (box.left < 0) window.scrollBy(box.left, 0);
    else if (box.right > width) window.scrollBy(box.right - width, 0);
  }

  /** Moves on from `column`'s header to its first cell, if there are rows. */
  function leaveHeader(column: number) {
    focusGrid();
    if (size.rows === 0) return;
    const cell = { row: 0, column };
    select(collapsed(cell), cell);
  }

  /** Makes `column`'s header active, in place of any cell. */
  function activateHeader(column: number) {
    setSelection(null);
    setHeaderColumn(column);
    revealColumn(column);
  }

  function select(next: GridSelection, show: CellPosition, scrollRows = 0) {
    setSelection(next);
    reveal(show, scrollRows);
  }

  /** Starts editing `cell`, with the caret at `caret`; with `text`, replacing what's there. */
  function startEditing(cell: CellPosition, caret: number, text?: string) {
    setSelection(collapsed(cell));
    setEditing({ cell, caret, text });
  }

  /** Whether `cell` can be edited and has nothing in it. */
  function isEmpty(cell: CellPosition) {
    return editorOf(cell.column)?.editText(rows[cell.row]!) === "";
  }

  /**
   * What Enter does from `cell`, edited or not: makes the cell below (or
   * above) active, editing it straight away if it's empty, as pressing it
   * would. At the grid's edge, `cell` stays active.
   */
  function enter(cell: CellPosition, up: boolean) {
    const next = move(collapsed(cell), { kind: "step", direction: up ? "up" : "down" }, size);
    reveal(next.active);
    if (!samePosition(next.active, cell) && isEmpty(next.active)) startEditing(next.active, 0);
    else setSelection(next);
  }

  function finishEditing(cell: CellPosition, how: FinishHow) {
    // Only if still editing this cell: pressing another cell finishes this
    // one after the other has started.
    setEditing((current) => (current && samePosition(current.cell, cell) ? null : current));
    if (how === "away") return;
    if (how === "down" || how === "up") enter(cell, how === "up");
    else {
      const next =
        how === "stay" ? collapsed(cell) : tab(collapsed(cell), how === "previous", size);
      select(next, next.active);
    }
    focusGrid();
  }

  function submit(
    row: TransactionRow,
    rowIndex: number,
    editor: CellEditor,
    text: string,
    create: boolean,
  ): SubmitResult {
    // Unchanged text is never parsed, so a stored value the parser wouldn't
    // accept can still be left as it is.
    if (text === editor.editText(row)) return { ok: true };
    const result = editor.parse(text, row, { categories, accounts, create });
    if (!result.ok) return result;
    // Typed differently but the same value, like `1234.5` for `1234.50`.
    if (hasPatch(row, result.value)) return { ok: true };
    onCommit([{ rowIndex, field: editor.field, patch: result.value }]);
    return { ok: true };
  }

  /** What `row`'s emptied cell stores, or why it can't be empty. */
  function clearedValue(editor: CellEditor, row: TransactionRow) {
    return editor.parse("", row, { categories, accounts, create: false });
  }

  /** Empties the cells in `area` that can be empty, leaving the rest. */
  function clearCells(area: Bounds) {
    const changes: TransactionChange[] = [];
    for (let column = area.left; column <= area.right; column++) {
      const editor = editorOf(column);
      if (!editor) continue;
      for (let index = area.top; index <= area.bottom; index++) {
        const row = rows[index]!;
        const cleared = clearedValue(editor, row);
        if (cleared.ok && !hasPatch(row, cleared.value))
          changes.push({ rowIndex: index, field: editor.field, patch: cleared.value });
      }
    }
    if (changes.length > 0) onCommit(changes);
  }

  // Which undo or redo has been shown; the effect runs again when the page
  // is shown again, and mustn't select it again then.
  const shownUndoOrRedoRef = useRef<typeof lastUndoOrRedo>(null);
  useEffect(() => {
    if (lastUndoOrRedo === null || lastUndoOrRedo === shownUndoOrRedoRef.current) return;
    shownUndoOrRedoRef.current = lastUndoOrRedo;
    const { about } = lastUndoOrRedo.step;
    if (about.kind !== "transaction") return;
    const indexOf = new Map(rows.map((row, index) => [row.id, index]));
    const next = covering(
      about.cells.flatMap(({ id, field }) => {
        const row = indexOf.get(id);
        return row === undefined ? [] : [{ row, column: columnOf(field) }];
      }),
    );
    if (next) select(next, next.active);
  });

  function handleKeyDown(event: KeyboardEvent) {
    // Keys typed into a cell's input, or a header's menu, are theirs.
    if (event.target !== event.currentTarget) return;
    if (activeHeader !== null) handleHeaderKey(event, activeHeader);
    else if (selection !== null) handleCellKey(event, selection);
  }

  /**
   * Keys on an active header: Left and Right (and Home and End) move along
   * the headers, Down goes back to the first row, and Enter, Space or
   * Alt+Down open the column's menu, if it has one.
   */
  function handleHeaderKey(event: KeyboardEvent, column: number) {
    const last = columns.length - 1;
    const along: Record<string, number> = {
      ArrowLeft: column - 1,
      ArrowRight: column + 1,
      Home: 0,
      End: last,
    };
    if (Object.hasOwn(along, event.key)) {
      event.preventDefault();
      const next = Math.min(Math.max(along[event.key]!, 0), last);
      setHeaderColumn(next);
      revealColumn(next);
    } else if (
      event.key === "Enter" ||
      event.key === " " ||
      (event.key === "ArrowDown" && event.altKey)
    ) {
      const menu = menusRef.current[column];
      if (!menu) return;
      event.preventDefault();
      menu.open();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      leaveHeader(column);
    }
  }

  function handleCellKey(event: KeyboardEvent, selection: GridSelection) {
    const { active } = selection;
    const motion = motionFor(event, pageRows());
    const editor = editorOf(active.column);

    if (motion) {
      event.preventDefault();
      // Up from the first row goes on to the column's header.
      if (
        motion.kind === "step" &&
        motion.direction === "up" &&
        !event.shiftKey &&
        active.row === 0
      ) {
        activateHeader(active.column);
        return;
      }
      const next = event.shiftKey ? extend(selection, motion, size) : move(selection, motion, size);
      select(
        next,
        event.shiftKey ? next.head : next.active,
        motion.kind === "rows" ? motion.count : 0,
      );
    } else if (event.key === "Tab") {
      const next = tab(selection, event.shiftKey, size);
      // At the grid's first or last cell, Tab leaves the grid.
      if (samePosition(next.active, active)) return;
      event.preventDefault();
      select(next, next.active);
    } else if (event.key === "Escape" && isRange(selection)) {
      event.preventDefault();
      setSelection(collapsed(active));
    } else if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      if (isRange(selection)) clearCells(bounds(selection));
      else if (!editor) return;
      // Delete clears a cell that can be empty. Otherwise it, and Backspace
      // always, start an edit of empty text.
      else if (event.key === "Delete" && clearedValue(editor, rows[active.row]!).ok)
        clearCells(bounds(selection));
      else {
        reveal(active);
        startEditing(active, 0, "");
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      enter(active, event.shiftKey);
    } else if (editor && event.key === "F2") {
      event.preventDefault();
      reveal(active);
      startEditing(active, editor.editText(rows[active.row]!).length);
    } else if (editor && isTypedCharacter(event)) {
      event.preventDefault();
      reveal(active);
      startEditing(active, event.key.length, event.key);
    }
  }

  const drag = useMouseDrag({
    move: ({ x, y }) => {
      const current = dragRef.current!;
      const cell = cellAtPoint(layout(), size, x, y);
      current.ranging = !samePosition(cell, current.origin);
      setSelection((selected) => {
        const next = { active: current.origin, head: cell };
        return selected &&
          samePosition(selected.active, next.active) &&
          samePosition(selected.head, next.head)
          ? selected
          : next;
      });
      const input = inputRef.current;
      if (!current.ranging && current.textAnchor !== null && input)
        selectBetween(input, current.textAnchor, textOffsetAtPoint(input, x, y));
    },
    end: () => {
      // A range was selected: an edit the press started or carried on ends
      // here, saved as if the user had clicked away.
      if (dragRef.current!.ranging) focusGrid();
      dragRef.current = null;
    },
    autoScroll: () => dragRef.current?.ranging ?? false,
    topInset: () => headerRowRef.current!.getBoundingClientRect().bottom,
  });

  /** Where the cells are on screen now. */
  function layout() {
    return {
      top: bodyRef.current!.getBoundingClientRect().top,
      rowHeight: ROW_HEIGHT,
      columnLefts: [...headerRowRef.current!.children].map(
        (header) => header.getBoundingClientRect().left,
      ),
    };
  }

  /** A press on a header makes it active; on its button, the browser also opens its menu. */
  function handleHeaderPress(column: number, event: MouseEvent) {
    if (event.button !== 0) return;
    // Focus stays on the grid, so the keyboard carries on from the header.
    event.preventDefault();
    // Moving focus here first ends any edit, submitting it.
    focusGrid();
    activateHeader(column);
  }

  function handlePress(cell: CellPosition, event: MouseEvent, offset: number | null) {
    const point: Point = { x: event.clientX, y: event.clientY };
    const input = inputRef.current;
    const isEditing = editing !== null && samePosition(editing.cell, cell) && input !== null;

    if (event.shiftKey && selection && !isEditing) {
      // Extends the range from the active cell, ending any edit.
      focusGrid();
      setSelection({ active: selection.active, head: cell });
      dragRef.current = {
        origin: selection.active,
        textAnchor: null,
        ranging: !samePosition(cell, selection.active),
      };
    } else if (isEditing) {
      // Pressing inside the input: place the caret or select text, like the
      // browser would.
      const at = textOffsetAtPoint(input, point.x, point.y);
      let textAnchor: number | null = null;
      if (event.detail === 2) input.setSelectionRange(...wordAt(input.value, at));
      else if (event.detail >= 3) input.select();
      else {
        textAnchor = event.shiftKey ? selectionAnchor(input) : at;
        selectBetween(input, textAnchor, at);
      }
      dragRef.current = { origin: cell, textAnchor, ranging: false };
    } else {
      // An empty cell has nothing to select, so pressing it edits it. Others
      // are edited by pressing again once active (so a double-click edits).
      const edits =
        offset !== null &&
        (isEmpty(cell) ||
          (selection !== null && !isRange(selection) && samePosition(selection.active, cell)));
      // Moving focus here first ends any other edit, submitting it.
      focusGrid();
      if (edits) startEditing(cell, offset);
      else setSelection(collapsed(cell));
      dragRef.current = { origin: cell, textAnchor: edits ? offset : null, ranging: false };
    }
    drag(point);
  }

  const area = selection && bounds(selection);
  const ranged = selection !== null && isRange(selection);

  return (
    <div
      ref={gridRef}
      role="grid"
      tabIndex={0}
      aria-rowcount={rows.length + 1}
      aria-multiselectable
      aria-activedescendant={
        selection
          ? cellId(selection.active)
          : activeHeader !== null
            ? headerId(activeHeader)
            : undefined
      }
      onKeyDown={handleKeyDown}
      onFocus={(event) => {
        // Tabbing into the grid starts at its first cell, or without rows,
        // its first header. A click focuses it too, but one on a cell or a
        // header makes that active, and one elsewhere, nothing.
        if (
          event.target !== event.currentTarget ||
          selection !== null ||
          activeHeader !== null ||
          !event.currentTarget.matches(":focus-visible")
        )
          return;
        if (size.rows > 0) setSelection(collapsed({ row: 0, column: 0 }));
        else activateHeader(0);
      }}
      className="cursor-default text-sm outline-none"
    >
      <div role="rowgroup" className="sticky top-0 z-20 bg-canvas">
        {table.getHeaderGroups().map((group) => (
          <div
            key={group.id}
            ref={headerRowRef}
            role="row"
            aria-rowindex={1}
            className="grid border-y border-line"
            style={{ gridTemplateColumns: GRID_TEMPLATE, height: HEADER_HEIGHT }}
          >
            {group.headers.map((header, column) => {
              const { headerMenu } = header.column.columnDef.meta!;
              const label = <table.FlexRender header={header} />;
              return (
                <div
                  key={header.id}
                  id={headerId(column)}
                  role="columnheader"
                  aria-sort={
                    headerMenu && menus?.sort.column === headerMenu
                      ? menus.sort.direction
                      : undefined
                  }
                  onMouseDown={(event) => handleHeaderPress(column, event)}
                  className={`flex items-center truncate border-r border-line font-mono text-xs tracking-widest text-ink-muted uppercase last:border-r-0 ${
                    headerMenu && menus ? "" : "px-2"
                  } ${activeHeader === column ? "outline-2 -outline-offset-2 outline-focus" : ""}`}
                >
                  {headerMenu && menus
                    ? menus.render(headerMenu, {
                        label,
                        menuRef: (menu) => {
                          menusRef.current[column] = menu;
                        },
                        onDone: () => leaveHeader(column),
                      })
                    : label}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div
        ref={bodyRef}
        role="rowgroup"
        className="relative"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]!;
          const isEditingRow = editing?.cell.row === item.index;
          return (
            <div
              key={item.key}
              role="row"
              aria-rowindex={item.index + 2}
              className="absolute inset-x-0 grid leading-7"
              style={{
                gridTemplateColumns: GRID_TEMPLATE,
                height: ROW_HEIGHT,
                // Placed with top, not a transform: the edited cell's popups
                // are anchored to it (see EditableCell), and Firefox places
                // them wrongly against a transformed anchor.
                top: item.start - scrollMargin,
              }}
            >
              {leafColumns.map((leafColumn, column) => {
                const meta = leafColumn.columnDef.meta!;
                const editor = meta.editor;
                const position = { row: item.index, column };
                const selected = area !== null && contains(area, position);
                const isEditing = isEditingRow && editing.cell.column === column;
                const editText = editor?.editText(row);
                return (
                  <EditableCell
                    key={leafColumn.id}
                    id={cellId(position)}
                    display={meta.display(row)}
                    align={meta.align}
                    mono={meta.mono}
                    editText={editText}
                    active={selection !== null && samePosition(selection.active, position)}
                    selected={selected}
                    rangeEdges={ranged && selected ? edges(area!, position) : undefined}
                    editing={
                      isEditing && editor
                        ? {
                            text: editing.text ?? editText!,
                            caret: editing.caret,
                            typed: editing.text !== undefined,
                            menu: editor.menu?.({ categories, accounts }),
                            paused: ranged,
                            inputRef,
                            submit: (text, create) => submit(row, item.index, editor, text, create),
                            finish: (how) => finishEditing(position, how),
                            history: onUndoOrRedo,
                          }
                        : undefined
                    }
                    onPress={(event, offset) => handlePress(position, event, offset)}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A key that types a character, rather than a shortcut or a control key.
 * AltGr types characters too, though Windows also reports it as Ctrl+Alt.
 */
function isTypedCharacter(event: KeyboardEvent) {
  const shortcut =
    event.metaKey || ((event.ctrlKey || event.altKey) && !event.getModifierState("AltGraph"));
  return [...event.key].length === 1 && !shortcut;
}

export default TransactionsTable;
