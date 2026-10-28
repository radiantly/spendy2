import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from "react";
import { toast } from "sonner";
import { mapOffset, textOffsetAtPoint } from "./caret.ts";
import type { Edges } from "./grid.ts";
import { historyKey, type HistoryDirection } from "../../lib/historyKey.ts";
import { defaultHighlight, menuItems, type MenuConfig, type MenuItem } from "./menu.ts";
import { splitChange, type Part } from "./prefix.ts";

/** The outcome of submitting an edit: accepted, or why not. */
export type SubmitResult = { ok: true } | { ok: false; error: string };

/**
 * How an edit ended: with the cell kept active (Escape), moving to the cell
 * below or above (Enter, Shift+Enter), moving to the next or previous cell
 * (Tab, Shift+Tab), or by focus going elsewhere.
 */
export type FinishHow = "stay" | "down" | "up" | "next" | "previous" | "away";

/** Where an edit starts: in which part's input, with what selected there (a caret where both ends are the same). */
export type EditStart = { part: Part; selection: readonly [number, number] };

export type CellEditing = {
  /** The text the input starts with. */
  text: string;
  /** The input's label: its column's name. */
  label: string;
  /**
   * For a cell with an editable prefix, like the currency in `USD 10.00`:
   * the prefix its own input starts with, and that input's label (see
   * prefix.ts).
   */
  prefix?: { text: string; label: string };
  start: EditStart;
  /** Whether the edit was started by typing, rather than with the cell's own: the menu lists only matches. */
  typed: boolean;
  /** Makes the input a combobox with this menu of options. */
  menu?: MenuConfig;
  /**
   * While a drag from this cell selects other cells, the edit is paused: its
   * menu, error, caret and text selection are hidden until the drag comes back.
   */
  paused: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  /**
   * `create` is set when the user picked the menu's create item. `prefix`
   * is the prefix as edited, for a cell with one.
   */
  submit: (text: string, create: boolean, prefix?: string) => SubmitResult;
  finish: (how: FinishHow) => void;
  /** Undoes or redoes the table's last change, once the edit has finished. */
  history: (direction: HistoryDirection) => void;
};

type EditableCellProps = {
  id: string;
  /** What the cell shows. */
  display: string;
  align?: "end";
  tabular?: boolean;
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
  tabular,
  editText,
  active,
  selected,
  rangeEdges,
  editing,
  onPress,
}: EditableCellProps) {
  const textRef = useRef<HTMLSpanElement>(null);

  function handleMouseDown(event: MouseEvent) {
    if (event.button !== 0) return;
    // The grid places the caret and selects text itself, so it can carry
    // on doing so when a drag leaves the cell and comes back.
    event.preventDefault();
    // Where in the edit text the press was, by where it was in the cell's.
    const offset =
      editText === undefined || editing
        ? null
        : mapOffset(
            display,
            textOffsetAtPoint(textRef.current!, event.clientX, event.clientY),
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
      } ${active ? "outline-2 -outline-offset-2 outline-focus" : ""} ${align === "end" ? "text-right" : ""} ${tabular ? "tabular-nums" : ""}`}
    >
      {editing ? (
        <CellInput {...editing} align={align} />
      ) : (
        <div className="truncate">
          <span ref={textRef}>{display}</span>
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
 * The input a cell turns into. Enter submits and moves down (Shift+Enter, up);
 * Escape cancels,
 * keeping the cell active; Tab submits and moves on. Undo and redo (Ctrl+Z,
 * Ctrl+Y) are the input's own in an edit started by typing, or once its text
 * has changed; otherwise they finish the edit and undo or redo the table's
 * last change. Leaving the cell
 * submits too, but can't show an error there, so an invalid value is undone
 * instead. With a `menu`, it's a combobox: up and down move through the
 * options, and Enter, Tab or leaving picks the highlighted one.
 *
 * With a `prefix`, it has an input of its own before the text's: typing
 * either's characters into the other switches to it, cleared, and both
 * inputs edit the cell, with the same keys (see prefix.ts).
 */
function CellInput({
  text: initialText,
  label,
  prefix: initialPrefix,
  start: {
    part: startPart,
    selection: [selectionStart, selectionEnd],
  },
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
  const hasPrefix = initialPrefix !== undefined;
  const [prefix, setPrefix] = useState(initialPrefix?.text ?? "");
  const prefixRef = useRef<HTMLInputElement>(null);
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
    const input = (startPart === "prefix" ? prefixRef : inputRef).current!;
    input.focus();
    input.setSelectionRange(selectionStart, selectionEnd);
  }, [inputRef, startPart, selectionStart, selectionEnd]);

  const inputOf = (part: Part) => (part === "prefix" ? prefixRef : inputRef).current!;

  function setPart(part: Part, value: string) {
    if (part === "text") handleChange(value);
    else {
      setPrefix(value);
      setError(null);
    }
  }

  /**
   * A change to `part`'s input, of a cell with a prefix: what's put in for
   * the other part replaces its value, and if it came last, typing carries
   * on there (see prefix.ts). Every way of changing them (typing, pasting,
   * an input method) ends up here.
   *
   * The inputs are given their values straight away: React only sets an
   * input's value when its state changes, so where it stays the same, it
   * would put back the one from before the change itself, losing the
   * selection.
   */
  function handlePartChange(part: Part, input: HTMLInputElement) {
    const before = part === "prefix" ? prefix : text;
    const change = splitChange(part, before, input.value, input.selectionStart!);
    if (input.value !== change.value) input.value = change.value;
    input.setSelectionRange(...change.selection);
    setPart(part, change.value);
    if (change.other === "") return;
    const other: Part = part === "prefix" ? "text" : "prefix";
    setPart(other, change.other);
    if (!change.switches) return;
    const otherInput = inputOf(other);
    otherInput.focus();
    otherInput.value = change.other;
    otherInput.setSelectionRange(change.other.length, change.other.length);
  }

  function done(how: FinishHow) {
    finishedRef.current = true;
    finish(how);
  }

  function trySubmit(value: string, create: boolean, how: FinishHow) {
    const result = submit(value, create, hasPrefix ? prefix : undefined);
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
    if (direction && !typed && text === initialText && prefix === (initialPrefix?.text ?? "")) {
      event.preventDefault();
      done("stay");
      history(direction);
    } else if (event.key === "Escape") {
      event.preventDefault();
      done("stay");
    } else if (event.key === "Enter") {
      event.preventDefault();
      commit(event.shiftKey ? "up" : "down");
    } else if (event.key === "Tab") {
      event.preventDefault();
      commit(event.shiftKey ? "previous" : "next");
    } else if (menu && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlight(Math.min(Math.max(highlight + step, 0), items.length - 1));
    }
  }

  function handleBlur(event: FocusEvent<HTMLInputElement>) {
    // Moving to the cell's other input, in the same frame, doesn't leave it.
    const frame = event.currentTarget.parentElement!;
    if (finishedRef.current || frame.contains(event.relatedTarget as Node | null)) return;
    // Leaving picks a highlighted option, but never creates one: that takes
    // Enter or a click on the create item.
    const item = items[highlight];
    const result = submit(
      item?.kind === "option" ? item.value : text,
      false,
      hasPrefix ? prefix : undefined,
    );
    // There's no cell left to show the error on, so say why it was undone.
    if (!result.ok) toast.error(`${result.error}. The change was undone.`);
    done("away");
  }

  // One popup at a time: an error replaces the menu until the text changes.
  const showMenu =
    menu !== undefined && !paused && error === null && (items.length > 0 || text.trim() !== "");
  const showError = error !== null && !paused;

  const invalid = {
    "aria-invalid": error !== null || undefined,
    "aria-errormessage": showError ? errorId : undefined,
  };
  // With a prefix, each input is only as wide as its text, so the prefix and
  // the text sit together like words, and the text where the cell showed it;
  // empty, as wide as a character.
  const inputClass = `cursor-text bg-transparent outline-none ${
    hasPrefix ? "min-w-[1ch] [field-sizing:content]" : "min-w-0"
  } ${paused ? "caret-transparent selection:bg-transparent" : ""}`;

  return (
    <>
      <div
        style={{ anchorName: EDITED_CELL }}
        className={`absolute inset-0 flex cursor-text bg-surface px-2 outline-2 -outline-offset-2 ${
          error !== null ? "outline-danger" : "outline-focus"
        } ${align === "end" ? "justify-end" : ""}`}
      >
        {initialPrefix && (
          <>
            <input
              ref={prefixRef}
              value={prefix}
              aria-label={initialPrefix.label}
              onChange={(event) => handlePartChange("prefix", event.target)}
              onKeyDown={handleKeyDown}
              onBlur={handleBlur}
              // Its caret and selection are the browser's, not placed by the grid.
              onMouseDown={(event) => event.stopPropagation()}
              {...invalid}
              className={`text-ink-muted focus:text-ink ${inputClass}`}
            />
            {/* The space before the text, the font's own. */}
            <span aria-hidden className="whitespace-pre">
              {" "}
            </span>
          </>
        )}
        <input
          ref={inputRef}
          value={text}
          aria-label={label}
          onChange={(event) =>
            hasPrefix ? handlePartChange("text", event.target) : handleChange(event.target.value)
          }
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          role={menu ? "combobox" : undefined}
          aria-autocomplete={menu ? "list" : undefined}
          aria-expanded={menu ? showMenu && items.length > 0 : undefined}
          aria-controls={menu ? menuId : undefined}
          aria-activedescendant={showMenu && highlight >= 0 ? `${menuId}-${highlight}` : undefined}
          {...invalid}
          className={`${inputClass} ${
            hasPrefix ? "" : `flex-1 ${align === "end" ? "text-right" : ""}`
          }`}
        />
      </div>
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
        <CellPopup
          id={errorId}
          role="alert"
          onMouseDown={stopPress}
          className="rounded-md border-0 bg-danger px-2 py-1 font-sans text-xs whitespace-nowrap text-white"
        >
          {error}
        </CellPopup>
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

/** The anchor name of the edited cell's input, which its popups sit by. */
const EDITED_CELL = "--edited-cell";

/**
 * A popup of the edited cell, in the top layer: over everything, the sticky
 * header too. It sits under the cell, or where there's no room, over it (or
 * flipped sideways), as the browser works out again while the page scrolls.
 */
function CellPopup({ className = "", style, ...props }: ComponentProps<"div">) {
  const ref = useRef<HTMLDivElement>(null);
  // Shown as it mounts, before it's painted. Unmounting it hides it.
  useLayoutEffect(() => ref.current!.showPopover(), []);
  return (
    <div
      ref={ref}
      popover="manual"
      {...props}
      // Over the browser's popover defaults: in the middle of the window, padded.
      className={`m-0 mt-1 p-0 [inset:auto] ${className}`}
      style={{
        positionAnchor: EDITED_CELL,
        top: "anchor(bottom)",
        left: "anchor(left)",
        positionTryFallbacks: "flip-block, flip-inline, flip-block flip-inline",
        ...style,
      }}
    />
  );
}

/** The combobox's options. Focus stays in the input throughout. */
function Menu({ id, items, highlight, noMatch, onHighlight, onPick }: MenuProps) {
  const listRef = useRef<HTMLUListElement>(null);

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
    <CellPopup
      // Keeps focus in the input, so picking doesn't blur it first.
      onMouseDown={stopPress}
      className="w-max max-w-80 cursor-default overflow-hidden rounded-md border border-line bg-surface font-sans text-ink shadow-lg"
      // At least as wide as the cell.
      style={{ minWidth: "anchor-size(width)" }}
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
    </CellPopup>
  );
}

export default EditableCell;
