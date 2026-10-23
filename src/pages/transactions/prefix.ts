/**
 * Editing a cell with an editable prefix, like the currency in `USD 10.00`:
 * the prefix and the text each have an input. Letters are the prefix's,
 * spaces neither's, and anything else the text's, whichever input they're
 * typed or pasted into. Typing into one the other's characters switches to
 * the other, cleared, so they start it over.
 */

/** The two parts of the cell. */
export type Part = "prefix" | "text";

const LETTER = /\p{L}/u;
const SPACE = /\s/u;

/** Which part a character typed into the cell is for, if any. */
export function partFor(character: string): Part | null {
  if (LETTER.test(character)) return "prefix";
  return SPACE.test(character) ? null : "text";
}

const otherPart = (part: Part): Part => (part === "prefix" ? "text" : "prefix");

/** A change to one part's input, split between the two parts. */
export type PartChange = {
  /**
   * The part's value: as changed, with only its own characters, or as it
   * was if none of them were put in (even over a selection).
   */
  value: string;
  /** What to select in `value`: a caret after what was put in, or what the change replaced. */
  selection: [number, number];
  /** The other part's characters that were put in, which replace its value. */
  other: string;
  /** Whether what was put in ends with the other part's characters, so typing carries on there. */
  switches: boolean;
};

/**
 * Splits the change of `part`'s input from `before`, which has only its
 * characters, to `after`, with the caret now at `caret`.
 */
export function splitChange(part: Part, before: string, after: string, caret: number): PartChange {
  // What was put in is what `after` doesn't share with `before` at either
  // end. Other characters are all in it, as `before` has none to share.
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end++;
  const inserted = [...after.slice(start, after.length - end)];
  const other = inserted.filter((character) => partFor(character) === otherPart(part)).join("");
  const last = inserted.findLast((character) => partFor(character) !== null);
  const switches = last !== undefined && partFor(last) !== part;

  const own = (text: string) => [...text].filter((character) => partFor(character) === part);
  if (inserted.length > 0 && own(inserted.join("")).length === 0)
    return { value: before, selection: [start, before.length - end], other, switches };
  const at = own(after.slice(0, caret)).length;
  return { value: own(after).join(""), selection: [at, at], other, switches };
}
