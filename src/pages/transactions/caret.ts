/**
 * Placing the caret where a cell was pressed: find the character offset
 * under the pointer in the displayed text or the input, then translate a
 * displayed offset to the text the input starts with (which can differ,
 * e.g. `1,234.50` vs `1234.50`).
 */

/**
 * The character offset at a viewport point in `element`'s text, or in an
 * input's value. Points beside the text count as before or after it, by
 * horizontal position; for an input, as do points above (before) or below it
 * (after), like where a drag past it ends a selection.
 */
export function textOffsetAtPoint(element: HTMLElement, x: number, y: number): number {
  const isInput = element instanceof HTMLInputElement;
  const text = isInput ? element.value : (element.textContent ?? "");
  const box = element.getBoundingClientRect();
  if (isInput && y < box.top) return 0;
  if (isInput && y >= box.bottom) return text.length;

  const position = document.caretPositionFromPoint(x, y);
  if (position && isInput && position.offsetNode === element) return position.offset;
  if (position && !isInput && element.contains(position.offsetNode)) {
    const range = document.createRange();
    range.setStart(element, 0);
    range.setEnd(position.offsetNode, position.offset);
    return range.toString().length;
  }
  return x < box.left ? 0 : text.length;
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

const words = new Intl.Segmenter(undefined, { granularity: "word" });

/**
 * The start and end of the word at `offset`, as a double-click selects it:
 * the segment the offset is in, or the one ending there at the end of the text.
 */
export function wordAt(text: string, offset: number): [number, number] {
  if (text === "") return [0, 0];
  const segment = words.segment(text).containing(Math.min(offset, text.length - 1))!;
  return [segment.index, segment.index + segment.segment.length];
}

/** The end of an input's selection that stays put when Shift extends it. */
export function selectionAnchor(input: HTMLInputElement) {
  return input.selectionDirection === "backward" ? input.selectionEnd! : input.selectionStart!;
}

/** Selects from `anchor` to `focus` in an input, either way round. */
export function selectBetween(input: HTMLInputElement, anchor: number, focus: number) {
  input.setSelectionRange(
    Math.min(anchor, focus),
    Math.max(anchor, focus),
    focus < anchor ? "backward" : "forward",
  );
}
