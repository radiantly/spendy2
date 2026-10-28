/**
 * Undo and redo from outside the cells, like the action bar's, while a cell
 * may be being edited: what they do to the edit (see EditableCell's
 * `CellInput`, which does it), and whether they can do anything.
 */

import type { HistoryDirection } from "../../lib/historyKey.ts";

/**
 * An edit's undo and redo from outside its cell. While the edit leaves the
 * cell as it was, it finishes, and the table's last change is undone or
 * redone, as with the keys. Once it changes the cell, there's nothing to
 * redo (saving it would be a new change), and undo undoes the edit: saves
 * it, as leaving the cell would, and undoes that, so it can be redone; or,
 * if it can't be saved, drops it, as Escape does.
 */
export type CellHistory = { undoOrRedo: (direction: HistoryDirection) => void };

/**
 * Whether undo and redo from outside the cells can do anything, given
 * whether an edit has changed its cell, and whether the table has a change
 * to undo and one to redo. With no edit, or one that leaves the cell as it
 * was, they're the table's.
 */
export function cellHistoryAvailable(
  modified: boolean,
  table: { canUndo: boolean; canRedo: boolean },
) {
  return { canUndo: modified || table.canUndo, canRedo: !modified && table.canRedo };
}
