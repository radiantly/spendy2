/**
 * Placing the caret where a cell was clicked: find the character offset
 * under the pointer in the displayed text, then translate it to the text the
 * input starts with (which can differ, e.g. `1,234.50` vs `1234.50`).
 */

/**
 * The character offset in `element`'s text at a viewport point. Clicks
 * outside the text count as before or after it, by horizontal position.
 */
export function textOffsetAtPoint(element: HTMLElement, x: number, y: number): number {
  const text = element.textContent ?? "";
  const position = document.caretPositionFromPoint(x, y);
  if (position && element.contains(position.offsetNode)) {
    const range = document.createRange();
    range.setStart(element, 0);
    range.setEnd(position.offsetNode, position.offset);
    return range.toString().length;
  }
  return x < element.getBoundingClientRect().left ? 0 : text.length;
}

/**
 * Maps an offset in `displayed` to the same spot in `edited`, skipping
 * characters that only appear in one of them (like grouping commas). The
 * end maps to the end, even when the edited text has more digits.
 */
export function mapOffset(displayed: string, offset: number, edited: string): number {
  if (offset >= displayed.length) return edited.length;
  let d = 0;
  let e = 0;
  while (d < offset && e < edited.length) {
    if (displayed[d] === edited[e]) e++;
    d++;
  }
  return e;
}
