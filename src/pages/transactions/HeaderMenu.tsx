import {
  useId,
  useImperativeHandle,
  useRef,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { FaCaretDown, FaFilter } from "react-icons/fa6";
import { FiArrowDown, FiArrowUp } from "react-icons/fi";
import { CheckboxBox } from "../../components/Checkbox.tsx";
import type { SortDirection } from "./view.ts";

/** What the grid can do with a header's menu. */
export type HeaderMenuHandle = {
  /**
   * Opens the menu from the keyboard, focusing its current choice at once,
   * so the keys that follow are the menu's.
   */
  open: () => void;
};

/** What the grid gives a header with a menu. */
export type HeaderProps = {
  label: ReactNode;
  menuRef?: Ref<HeaderMenuHandle>;
  /** Enter in the menu: it's closed, and the grid moves on from the header. */
  onDone?: () => void;
};

type HeaderMenuProps = HeaderProps & {
  /** Names the anchor the menu sits by: unique among the headers. */
  column: string;
  /** Set when the column sorts the transactions. */
  sorted?: SortDirection;
  /** Whether the menu's filters hide any transactions. */
  filtered: boolean;
  children: ReactNode;
};

/**
 * A column header's contents that open a menu of ways to sort and filter by
 * the column. The header shows which way the column sorts, if it does, and
 * whether it filters.
 *
 * The menu is a popover in the top layer, so it's over the sticky header
 * and isn't clipped by the cell. The browser opens and closes it: pressing
 * outside it or Escape closes it, as does opening another header's, and
 * Escape puts focus back where it was. Opened from the keyboard, it focuses
 * its current choice (see `open`); opened by pointer, itself, so the keyboard
 * still works in it without a focus ring on a choice the pointer didn't pick.
 *
 * The button isn't in the tab order: the grid's keyboard reaches the headers
 * (see TransactionsTable).
 */
function HeaderMenu({
  column,
  label,
  menuRef,
  onDone,
  sorted,
  filtered,
  children,
}: HeaderMenuProps) {
  const buttonId = useId();
  const menuId = useId();
  const anchor = `--header-menu-${column}`;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuElementRef = useRef<HTMLDivElement>(null);
  useImperativeHandle(menuRef, () => ({
    open() {
      // Pressing the button, rather than showing the menu, makes it the
      // menu's button, so pressing it again closes the menu. The menu is shown
      // by the time the press returns, so its choice can be focused straight
      // away; its toggle event, which comes later, would be after keys
      // already pressed.
      buttonRef.current!.click();
      focusChoice(menuElementRef.current!);
    },
  }));

  /**
   * Keys in the menu, as in a menu rather than a form: Up and Down (and Home
   * and End) move through every choice, across the groups, without picking
   * one; Space picks or toggles it, as the inputs do themselves; Enter is
   * done with the menu. Other inputs (a custom range's dates) keep their own keys.
   */
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const menu = event.currentTarget;
    if (event.key === "Enter") {
      event.preventDefault();
      menu.hidePopover();
      onDone?.();
      return;
    }
    const choices = [
      ...menu.querySelectorAll<HTMLInputElement>("input[type=radio], input[type=checkbox]"),
    ];
    // -1 for the menu itself, focused when opened by pointer.
    const at = choices.indexOf(event.target as HTMLInputElement);
    if (at === -1 && event.target !== menu) return;
    const last = choices.length - 1;
    const to: Record<string, number> = {
      ArrowDown: Math.min(at + 1, last),
      ArrowUp: at === -1 ? last : Math.max(at - 1, 0),
      Home: 0,
      End: last,
    };
    if (Object.hasOwn(to, event.key)) {
      event.preventDefault();
      choices[to[event.key]!]?.focus();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      // A radio's own: it would pick the one beside it.
      event.preventDefault();
    }
  }

  return (
    <>
      {/* Before the button, so the button can style itself while it's open (peer-open). */}
      <div
        ref={menuElementRef}
        id={menuId}
        popover="auto"
        role="dialog"
        aria-labelledby={buttonId}
        tabIndex={-1}
        onToggle={(event) => {
          const menu = event.currentTarget;
          // Opened by pointer: `open` has already focused a choice otherwise.
          if (event.newState === "open" && !menu.contains(document.activeElement)) menu.focus();
        }}
        onKeyDown={handleKeyDown}
        // Pressing in the menu isn't pressing on the header.
        onMouseDown={(event) => event.stopPropagation()}
        // Over the browser's popover defaults: in the middle of the window,
        // padded. The header's type is inherited, so it's reset.
        className="peer m-0 mt-1 w-max max-w-96 overflow-y-auto rounded-md border border-line bg-surface p-0 py-1 text-sm font-normal whitespace-nowrap text-ink shadow-lg outline-none [inset:auto]"
        style={{
          positionAnchor: anchor,
          // Under the header, from its start; flipped to end at its end where
          // there's no room.
          positionArea: "block-end span-inline-end",
          positionTryFallbacks: "flip-inline",
          minWidth: "anchor-size(width)",
          // The position area's, less the margin above (mt-1), so it scrolls
          // rather than leaving the window.
          maxHeight: "calc(100% - 0.25rem)",
        }}
      >
        {children}
      </div>
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        tabIndex={-1}
        popoverTarget={menuId}
        style={{ anchorName: anchor }}
        // The label's colour stays the same whatever the column does: the
        // arrow and the badge say it sorts or filters.
        className="flex size-full min-w-0 cursor-default items-center gap-1.5 px-2 outline-none hover:bg-field hover:text-ink peer-open:bg-field peer-open:text-ink"
      >
        <span className="truncate">{label}</span>
        {sorted === "ascending" && <FiArrowUp aria-hidden className="shrink-0 stroke-3 text-ink" />}
        {sorted === "descending" && (
          <FiArrowDown aria-hidden className="shrink-0 stroke-3 text-ink" />
        )}
        {filtered && (
          <span className="grid size-4 shrink-0 place-items-center rounded-full bg-lime text-ink-on-lime">
            <FaFilter aria-hidden className="text-[8px]" />
            <span className="sr-only">(filtered)</span>
          </span>
        )}
        <FaCaretDown aria-hidden className="ml-auto shrink-0 text-[10px] text-ink-muted" />
      </button>
    </>
  );
}

/** Focuses the menu's current choice, as a select would, or its first. */
function focusChoice(menu: HTMLElement) {
  (menu.querySelector<HTMLInputElement>("input:checked") ?? menu.querySelector("input"))?.focus();
}

/** A titled group of a header menu's options. */
export function MenuGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    // min-w-0: fieldsets are otherwise as wide as their widest label, so long ones wouldn't be cut short.
    <fieldset className="min-w-0 border-b border-line pb-1 last:border-b-0">
      <legend className="px-3 pt-1.5 pb-1 text-xs font-medium text-ink-muted">{title}</legend>
      {children}
    </fieldset>
  );
}

/**
 * Where an item at `level` starts. Each level puts its box under the label
 * of the level above: past that box (1rem) and the gap after it (gap-2.5).
 */
function indent(level: number) {
  return { paddingInlineStart: `${0.75 + level * 1.625}rem` };
}

const itemClass = "flex items-center gap-2.5 py-1.5 pr-3 hover:bg-field";

type ItemProps = {
  label: string;
  /** Shown after the label, quieter, e.g. the dates an option covers. */
  hint?: string;
  /**
   * The widest `hint` can get, for one that changes or comes and goes: its
   * room is kept, so the menu doesn't change width with it.
   */
  hintRoom?: string;
  checked: boolean;
  /** How far the item is nested under others, e.g. 1 under a "check all" item. */
  level?: number;
};

/** The label and hint, after the item's box. A long label is cut short. */
function ItemText({ label, hint, hintRoom }: Pick<ItemProps, "label" | "hint" | "hintRoom">) {
  return (
    <>
      <span className="grow truncate">{label}</span>
      {(hint !== undefined || hintRoom !== undefined) && (
        // Stacked in one cell, so it's as wide as the wider of the two.
        <span className="grid shrink-0 justify-items-end pl-4 text-xs text-ink-muted tabular-nums">
          <span className="col-start-1 row-start-1">{hint}</span>
          <span aria-hidden className="invisible col-start-1 row-start-1">
            {hintRoom}
          </span>
        </span>
      )}
    </>
  );
}

/** One of a menu group's choices, where only one can be picked. */
export function RadioItem({
  name,
  label,
  hint,
  hintRoom,
  checked,
  level = 0,
  onPick,
}: ItemProps & { name: string; onPick: () => void }) {
  return (
    <label className={itemClass} style={indent(level)}>
      {/* Drawn like CheckboxBox. */}
      <span className="relative grid size-4 shrink-0 place-items-center">
        <input
          type="radio"
          name={name}
          checked={checked}
          onChange={onPick}
          className="peer size-4 cursor-pointer appearance-none rounded-full border border-line bg-field transition-[background-color,border-color,filter] checked:border-lime checked:bg-lime focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-focus enabled:hover:brightness-95"
        />
        {/* A dot over the input, as an inset shadow drawing it leaves a grainy seam in the ring. */}
        <span
          aria-hidden
          className="pointer-events-none absolute size-1.5 rounded-full bg-ink-on-lime opacity-0 transition-opacity peer-checked:opacity-100"
        />
      </span>
      <ItemText label={label} hint={hint} hintRoom={hintRoom} />
    </label>
  );
}

/**
 * One of a menu group's choices, where any can be picked. `indeterminate`
 * shows it's partly checked, for one that checks several others.
 */
export function CheckboxItem({
  label,
  hint,
  hintRoom,
  checked,
  level = 0,
  indeterminate,
  onToggle,
}: ItemProps & { indeterminate?: boolean; onToggle: (checked: boolean) => void }) {
  return (
    <label className={itemClass} style={indent(level)}>
      <CheckboxBox
        checked={checked}
        indeterminate={indeterminate}
        onChange={(event) => onToggle(event.target.checked)}
      />
      <ItemText label={label} hint={hint} hintRoom={hintRoom} />
    </label>
  );
}

/** Content under an item, lined up with its label like an item a level deeper. */
export function ItemDetails({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`pr-3 ${className}`} style={indent(1)}>
      {children}
    </div>
  );
}

/**
 * A filter by a list of values: an item that checks them all (or, with all
 * of them checked, unchecks them), and `children`, the values' own items,
 * under it, scrolled when there are many. `values` are those the items list,
 * and the filter keeps the ones `hidden`.
 */
export function CheckAll<T>({
  label,
  values,
  hidden,
  onHide,
  children,
}: {
  label: string;
  values: readonly T[];
  hidden: ReadonlySet<T>;
  onHide: (hidden: ReadonlySet<T>) => void;
  children: ReactNode;
}) {
  const shown = values.filter((value) => !hidden.has(value)).length;
  const all = shown === values.length;
  return (
    <>
      <CheckboxItem
        label={label}
        hint={all ? undefined : `${shown} of ${values.length}`}
        hintRoom={`${values.length} of ${values.length}`}
        checked={all}
        indeterminate={shown > 0 && !all}
        // Checking all also forgets values no longer listed.
        onToggle={(checked) => onHide(new Set(checked ? [] : values))}
      />
      {/* 7½ rows show, so a scrolled list doesn't look like it ends there. */}
      <div className="max-h-60 overflow-y-auto">{children}</div>
    </>
  );
}

export default HeaderMenu;
