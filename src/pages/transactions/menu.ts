/**
 * The options menu of a combobox cell: which items it lists for the text
 * typed so far, and which one Enter would pick.
 */

import { findName } from "./fields.ts";

export type MenuConfig = {
  /** Every option, in the order to list them. */
  options: readonly string[];
  /**
   * Offered when the text names no option, as the last item. Returns its
   * label, e.g. `Create category “Rent”`. Absent when only options are allowed.
   */
  createLabel?: (text: string) => string;
  /** Shown when nothing matches the text and nothing can be created. */
  noMatch: string;
};

export type MenuItem =
  | { kind: "option"; value: string }
  | { kind: "create"; value: string; label: string };

/**
 * The items for `text`. Until the user types (`filtering` false), every
 * option, so opening a cell shows what it can be changed to. Then the options
 * containing the text, ignoring case, with an exact match first.
 */
export function menuItems(config: MenuConfig, text: string, filtering: boolean): MenuItem[] {
  const value = text.trim();
  const wanted = value.toLowerCase();
  if (!filtering || wanted === "")
    return config.options.map((option) => ({ kind: "option", value: option }));

  const exact = findName(config.options, value);
  const items: MenuItem[] = config.options
    .filter((option) => option !== exact && option.toLowerCase().includes(wanted))
    .map((option) => ({ kind: "option", value: option }));
  if (exact !== undefined) items.unshift({ kind: "option", value: exact });
  else if (config.createLabel)
    items.push({ kind: "create", value, label: config.createLabel(value) });
  return items;
}

/**
 * The item highlighted for `text`, or -1 for none. Before typing, the cell's
 * current value; after, the first item. Empty text highlights nothing, so
 * Enter submits it as is (clearing the cell where that's allowed).
 */
export function defaultHighlight(items: MenuItem[], text: string, filtering: boolean): number {
  if (text.trim() === "") return -1;
  if (!filtering) {
    const current = findName(
      items.map((item) => item.value),
      text,
    );
    return items.findIndex((item) => item.value === current);
  }
  return items.length > 0 ? 0 : -1;
}
