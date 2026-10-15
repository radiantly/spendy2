import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from "react";
import toast from "react-hot-toast";
import type { CellDisplay } from "./columns.ts";
import { mapOffset, textOffsetAtPoint } from "./caret.ts";
import type { Edges } from "./grid.ts";
import { historyKey, type HistoryDirection } from "../../lib/historyKey.ts";
import { defaultHighlight, menuItems, type MenuConfig, type MenuItem } from "./menu.ts";

/** The outcome of submitting an edit: accepted, or why not. */
export type SubmitResult = { ok: true } | { ok: false; error: string };

/**
 * How an edit ended: with the cell kept active (Enter, Escape), moving to the
 * next or previous cell (Tab, Shift+Tab), or by focus going elsewhere.
 */
export type FinishHow = "stay" | "next" | "previous" | "away";

export type CellEditing = {
  /** The text the input starts with. */
  text: string;
  /** Where the caret starts. */
  caret: number;
  /** Whether the text was typed, rather than the cell's own: the menu lists only matches. */
  typed: boolean;
  /** Makes the input a combobox with this menu of options. */
  menu?: MenuConfig;
  /**
   * While a drag from this cell selects other cells, the edit is paused: its
   * menu, error, caret and text selection are hidden until the drag comes back.
   */
  paused: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  /** `create` is set when the user picked the menu's create item. */
  submit: (text: string, create: boolean) => SubmitResult;
  finish: (how: FinishHow) => void;
  /** Undoes or redoes the table's last change, once the edit has finished. */
  history: (direction: HistoryDirection) => void;
};

type EditableCellProps = {
  id: string;
  display: CellDisplay;
  align?: "end";
  mono?: boolean;
  /** The text an edit starts with. Absent for read-only cells. */
  editText?: string;
  active: boolean;
  selected: boolean;
  /** For a cell in a range of several: which of its sides are on the range's outline. */
  rangeEdges?: Edges;
  /** Set while the cell is being edited. */
  editing?: CellEditing;
  /**
   * The mouse went down on the cell. `offset` is where in the edit text it
   * was pressed, for an editable cell that isn't being edited yet.
   */
  onPress: (event: MouseEvent, offset: number | null) => void;
};

/** The outline of a range, drawn inside its outer cells. */
function rangeOutline(sides: Edges): CSSProperties {
  const line = "var(--color-focus)";
  const shadows = [
    sides.top && `inset 0 1px 0 ${line}`,
    sides.bottom && `inset 0 -1px 0 ${line}`,
    sides.left && `inset 1px 0 0 ${line}`,
    sides.right && `inset -1px 0 0 ${line}`,
  ].filter(Boolean);
  return shadows.length > 0 ? { boxShadow: shadows.join(", ") } : {};
}

/**
 * A spreadsheet-style cell: plain text that turns into an input when edited,
 * with the caret where it was pressed. Whether a press edits it, and what
 * else the press does (selecting, dragging), is up to the grid.
 */
function EditableCell({
  id,
  display,
  align,
  mono,
  editText,
  active,
  selected,
  rangeEdges,
  editing,
  onPress,
}: EditableCellProps) {
  const valueRef = useRef<HTMLSpanElement>(null);

  function handleMouseDown(event: MouseEvent) {
    if (event.button !== 0) return;
    // The grid places the caret and selects text itself, so it can carry
    // on doing so when a drag leaves the cell and comes back.
    event.preventDefault();
    const offset =
      editText === undefined || editing
        ? null
        : mapOffset(
            display.text,
            textOffsetAtPoint(valueRef.current!, event.clientX, event.clientY),
            editText,
          );
    onPress(event, offset);
  }

  return (
    <div
      id={id}
      role="gridcell"
      aria-selected={selected}
      aria-readonly={editText === undefined || undefined}
      onMouseDown={handleMouseDown}
      style={rangeEdges && rangeOutline(rangeEdges)}
      className={`relative min-w-0 border-r border-b border-line px-2 last:border-r-0 ${
        rangeEdges && !active ? "bg-focus/15" : ""
      } ${active ? "outline-2 -outline-offset-2 outline-focus" : ""} ${align === "end" ? "text-right" : ""} ${mono ? "font-mono" : ""}`}
    >
      {editing ? (
        <CellInput {...editing} align={align} />
      ) : (
        <div className="truncate">
          {display.prefix && <span className="text-ink-muted">{display.prefix}</span>}
          <span ref={valueRef}>{display.text}</span>
        </div>
      )}
    </div>
  );
}

/** Identifies a menu item across changes to the options. */
function itemKey(item: MenuItem | undefined) {
  return item === undefined ? null : `${item.kind}:${item.value}`;
}

/** Popups belong to the input: pressing on them isn't pressing on the cell. */
function stopPress(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
}

type CellInputProps = CellEditing & { align?: "end" };

/**
 * The input a cell turns into. Enter submits and Escape cancels, both
 * keeping the cell active; Tab submits and moves on. Undo and redo (Ctrl+Z,
 * Ctrl+Y) are the input's own in an edit started by typing, or once its text
 * has changed; otherwise they finish the edit and undo or redo the table's
 * last change. Leaving the cell
 * submits too, but can't show an error there, so an invalid value is undone
 * instead. With a `menu`, it's a combobox: up and down move through the
 * options, and Enter, Tab or leaving picks the highlighted one.
 */
function CellInput({
  text: initialText,
  caret,
  typed,
  menu,
  paused,
  inputRef,
  submit,
  finish,
  history,
  align,
}: CellInputProps) {
  const [text, setText] = useState(initialText);
  const [error, setError] = useState<string | null>(null);
  // Until the user types, the menu lists every option.
  const [filtering, setFiltering] = useState(typed);
  const items = menu ? menuItems(menu, text, filtering) : [];
  // Which item is highlighted, not where: the options can change while the
  // menu is open (the page refreshes them after each category edit).
  const [highlightKey, setHighlightKey] = useState(() =>
    itemKey(items[defaultHighlight(items, text, typed)]),
  );
  const found = items.findIndex((item) => itemKey(item) === highlightKey);
  const highlight = found >= 0 ? found : defaultHighlight(items, text, filtering);
  const setHighlight = (index: number) => setHighlightKey(itemKey(items[index]));
  // Enter, Escape and Tab finish the edit themselves; the blur that follows
  // when focus moves on must not submit again.
  const finishedRef = useRef(false);
  const menuId = useId();
  const errorId = useId();

  useLayoutEffect(() => {
    const input = inputRef.current!;
    input.focus();
    input.setSelectionRange(caret, caret);
  }, [inputRef, caret]);

  function done(how: FinishHow) {
    finishedRef.current = true;
    finish(how);
  }

  function trySubmit(value: string, create: boolean, how: FinishHow) {
    const result = submit(value, create);
    if (result.ok) done(how);
    else setError(result.error);
  }

  /** What Enter and Tab do. */
  function commit(how: FinishHow) {
    if (!menu) trySubmit(text, false, how);
    else if (highlight >= 0)
      trySubmit(items[highlight]!.value, items[highlight]!.kind === "create", how);
    // Nothing to pick: only empty text is submitted as is (to clear the
    // cell); anything else names no option, as the menu already says.
    else if (text.trim() === "") trySubmit(text, false, how);
  }

  function handleChange(value: string) {
    setText(value);
    setError(null);
    setFiltering(true);
    if (menu) {
      const next = menuItems(menu, value, true);
      setHighlightKey(itemKey(next[defaultHighlight(next, value, true)]));
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    const direction = historyKey(event);
    if (direction && !typed && text === initialText) {
      event.preventDefault();
      done("stay");
      history(direction);
    } else if (event.key === "Escape") {
      event.preventDefault();
      done("stay");
    } else if (event.key === "Enter") {
      event.preventDefault();
      commit("stay");
    } else if (event.key === "Tab") {
      event.preventDefault();
      commit(event.shiftKey ? "previous" : "next");
    } else if (menu && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlight(Math.min(Math.max(highlight + step, 0), items.length - 1));
    }
  }

  function handleBlur() {
    if (finishedRef.current) return;
    // Leaving picks a highlighted option, but never creates one: that takes
    // Enter or a click on the create item.
    const item = items[highlight];
    const result = submit(item?.kind === "option" ? item.value : text, false);
    // There's no cell left to show the error on, so say why it was undone.
    if (!result.ok) toast.error(`${result.error}. The change was undone.`);
    done("away");
  }

  // One popup at a time: an error replaces the menu until the text changes.
  const showMenu =
    menu !== undefined && !paused && error === null && (items.length > 0 || text.trim() !== "");
  const showError = error !== null && !paused;

  return (
    <>
      <input
        ref={inputRef}
        value={text}
        onChange={(event) => handleChange(event.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        role={menu ? "combobox" : undefined}
        aria-autocomplete={menu ? "list" : undefined}
        aria-expanded={menu ? showMenu && items.length > 0 : undefined}
        aria-controls={menu ? menuId : undefined}
        aria-activedescendant={showMenu && highlight >= 0 ? `${menuId}-${highlight}` : undefined}
        aria-invalid={error !== null || undefined}
        aria-errormessage={showError ? errorId : undefined}
        className={`absolute inset-0 w-full bg-surface px-2 outline-2 -outline-offset-2 ${
          error !== null ? "outline-danger" : "outline-focus"
        } ${paused ? "caret-transparent selection:bg-transparent" : ""} ${
          align === "end" ? "text-right" : ""
        }`}
      />
      {showMenu && (
        <Menu
          id={menuId}
          items={items}
          highlight={highlight}
          noMatch={menu.noMatch}
          onHighlight={setHighlight}
          onPick={(item) => trySubmit(item.value, item.kind === "create", "stay")}
        />
      )}
      {showError && (
        <div
          id={errorId}
          role="alert"
          onMouseDown={stopPress}
          className="absolute top-full left-0 z-10 mt-1 rounded-md bg-danger px-2 py-1 font-sans text-xs whitespace-nowrap text-white"
        >
          {error}
        </div>
      )}
    </>
  );
}

type MenuProps = {
  id: string;
  items: MenuItem[];
  highlight: number;
  noMatch: string;
  onHighlight: (index: number) => void;
  onPick: (item: MenuItem) => void;
};

/**
 * The combobox's options, below the cell, or above it when there's no room
 * below. Focus stays in the input throughout.
 */
function Menu({ id, items, highlight, noMatch, onHighlight, onPick }: MenuProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [above, setAbove] = useState(false);

  // Measured from the cell rather than the popup, so flipping it doesn't
  // change the answer.
  useLayoutEffect(() => {
    const popup = popupRef.current!;
    const cell = popup.parentElement!.getBoundingClientRect();
    const height = popup.offsetHeight;
    setAbove(cell.bottom + height > window.innerHeight && cell.top - height >= 0);
  }, [items.length]);

  // Scroll the list, not the page, to keep the highlighted option in view.
  useLayoutEffect(() => {
    const list = listRef.current;
    const option = list?.children[highlight] as HTMLElement | undefined;
    if (!list || !option) return;
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
  }, [highlight]);

  return (
    <div
      ref={popupRef}
      // Keeps focus in the input, so picking doesn't blur it first.
      onMouseDown={stopPress}
      className={`absolute left-0 z-20 w-max max-w-80 min-w-full cursor-default overflow-hidden rounded-md border border-line bg-surface font-sans shadow-lg ${
        above ? "bottom-full mb-1" : "top-full mt-1"
      }`}
    >
      {items.length > 0 ? (
        <ul ref={listRef} id={id} role="listbox" className="relative max-h-56 overflow-y-auto py-1">
          {items.map((item, index) => (
            <li
              key={`${item.kind}:${item.value}`}
              id={`${id}-${index}`}
              role="option"
              aria-selected={index === highlight}
              // Only hovering moves the highlight: a drag passing over the
              // menu on its way to other cells would otherwise change what
              // leaving the cell saves.
              onMouseMove={(event) =>
                event.buttons === 0 && index !== highlight && onHighlight(index)
              }
              onClick={() => onPick(item)}
              className={`truncate px-2 leading-7 ${index === highlight ? "bg-field" : ""}`}
            >
              {item.kind === "create" ? item.label : item.value}
            </li>
          ))}
        </ul>
      ) : (
        <p role="status" className="truncate px-2 leading-7 text-ink-muted">
          {noMatch}
        </p>
      )}
    </div>
  );
}

export default EditableCell;
