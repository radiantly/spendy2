import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import toast from "react-hot-toast";
import type { CellDisplay } from "./columns.ts";
import { mapOffset, textOffsetAtPoint } from "./caret.ts";
import { defaultHighlight, menuItems, type MenuConfig, type MenuItem } from "./menu.ts";

/** The outcome of submitting an edit: accepted, or why not. */
export type SubmitResult = { ok: true } | { ok: false; error: string };

type EditableCellProps = {
  display: CellDisplay;
  align?: "end";
  mono?: boolean;
  /** Absent for read-only cells. */
  edit?: {
    /** The text the input starts with. */
    text: string;
    /** Set while this cell is being edited: where the caret starts. */
    caret: number | null;
    /** Makes the input a combobox with this menu of options. */
    menu?: MenuConfig;
    start: (caret: number) => void;
    /** `create` is set when the user picked the menu's create item. */
    submit: (text: string, create: boolean) => SubmitResult;
    finish: () => void;
  };
};

/**
 * A spreadsheet-style cell: plain text that turns into an input as soon as
 * the mouse goes down on it, with the caret where it was pressed.
 */
function EditableCell({ display, align, mono, edit }: EditableCellProps) {
  const valueRef = useRef<HTMLSpanElement>(null);
  const cellRef = useRef<HTMLDivElement>(null);
  const editing = edit !== undefined && edit.caret !== null;

  function handleMouseDown(event: MouseEvent) {
    if (!edit || editing || event.button !== 0 || !valueRef.current) return;
    // Keep the browser from focusing the cell or selecting text; the input
    // takes focus instead. That also stops focus leaving another cell's
    // input, so blur it here to submit its edit first.
    event.preventDefault();
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
    const offset = textOffsetAtPoint(valueRef.current, event.clientX, event.clientY);
    edit.start(mapOffset(display.text, offset, edit.text));
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (!edit || editing || event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      edit.start(edit.text.length);
    }
  }

  return (
    <div
      ref={cellRef}
      role="cell"
      tabIndex={edit ? 0 : undefined}
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
      className={`relative min-w-0 border-r border-b border-line px-2 outline-none last:border-r-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus ${
        align === "end" ? "text-right" : ""
      } ${mono ? "font-mono" : ""}`}
    >
      {editing ? (
        <CellInput
          initialText={edit.text}
          caret={edit.caret!}
          menu={edit.menu}
          align={align}
          submit={edit.submit}
          finish={(refocus) => {
            edit.finish();
            // After Enter or Escape, keep the keyboard on this cell.
            if (refocus) cellRef.current?.focus();
          }}
        />
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

type CellInputProps = {
  initialText: string;
  caret: number;
  menu?: MenuConfig;
  align?: "end";
  submit: (text: string, create: boolean) => SubmitResult;
  finish: (refocus: boolean) => void;
};

/**
 * The input a cell turns into. Enter submits and Escape cancels; leaving the
 * cell submits too, but can't show an error there, so an invalid value is
 * undone instead. With a `menu`, it's a combobox: arrow keys move through the
 * options, and Enter or leaving picks the highlighted one.
 */
function CellInput({ initialText, caret, menu, align, submit, finish }: CellInputProps) {
  const [text, setText] = useState(initialText);
  const [error, setError] = useState<string | null>(null);
  // Until the user types, the menu lists every option.
  const [filtering, setFiltering] = useState(false);
  const items = menu ? menuItems(menu, text, filtering) : [];
  // Which item is highlighted, not where: the options can change while the
  // menu is open (the page refreshes them after each category edit).
  const [highlightKey, setHighlightKey] = useState(() =>
    itemKey(items[defaultHighlight(items, text, false)]),
  );
  const found = items.findIndex((item) => itemKey(item) === highlightKey);
  const highlight = found >= 0 ? found : defaultHighlight(items, text, filtering);
  const setHighlight = (index: number) => setHighlightKey(itemKey(items[index]));
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter and Escape finish the edit themselves; the blur that follows when
  // the input unmounts must not submit again.
  const finishedRef = useRef(false);
  const menuId = useId();

  useLayoutEffect(() => {
    const input = inputRef.current!;
    input.focus();
    input.setSelectionRange(caret, caret);
  }, [caret]);

  function done(refocus: boolean) {
    finishedRef.current = true;
    finish(refocus);
  }

  function trySubmit(value: string, create: boolean) {
    const result = submit(value, create);
    if (result.ok) done(true);
    else setError(result.error);
  }

  function pick(item: MenuItem) {
    trySubmit(item.value, item.kind === "create");
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
    if (event.key === "Escape") {
      event.preventDefault();
      done(true);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (!menu) trySubmit(text, false);
      else if (highlight >= 0) pick(items[highlight]!);
      // Nothing to pick: only empty text is submitted as is (to clear the
      // cell); anything else names no option, as the menu already says.
      else if (text.trim() === "") trySubmit(text, false);
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
    done(false);
  }

  // One popup at a time: an error replaces the menu until the text changes.
  const showMenu = menu !== undefined && error === null && (items.length > 0 || text.trim() !== "");

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
        aria-activedescendant={highlight >= 0 ? `${menuId}-${highlight}` : undefined}
        aria-invalid={error !== null || undefined}
        aria-errormessage={error !== null ? "cell-error" : undefined}
        className={`absolute inset-0 w-full bg-surface px-2 outline-2 -outline-offset-2 ${
          error !== null ? "outline-danger" : "outline-focus"
        } ${align === "end" ? "text-right" : ""}`}
      />
      {showMenu && (
        <Menu
          id={menuId}
          items={items}
          highlight={highlight}
          noMatch={menu.noMatch}
          onHighlight={setHighlight}
          onPick={pick}
        />
      )}
      {error !== null && (
        <div
          id="cell-error"
          role="alert"
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
      // Keep focus in the input, so picking doesn't blur it first.
      onMouseDown={(event) => event.preventDefault()}
      className={`absolute left-0 z-20 w-max max-w-80 min-w-full overflow-hidden rounded-md border border-line bg-surface font-sans shadow-lg ${
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
              onMouseMove={() => index !== highlight && onHighlight(index)}
              onClick={() => onPick(item)}
              className={`cursor-default truncate px-2 leading-7 ${
                index === highlight ? "bg-field" : ""
              }`}
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
