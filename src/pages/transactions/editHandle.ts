/**
 * What can be done to a cell's edit from outside it, like the action bar,
 * while a cell may be being edited: what it does to the edit (see
 * EditableCell's `CellInput`, which does it), and whether undo and redo can
 * do anything.
 */

import type { HistoryDirection } from "../../lib/historyKey.ts";

export type EditHandle = {
  /**
   * Undoes or redoes. While the edit leaves the cell as it was, it
   * finishes, and the table's last change is undone or redone, as with the
   * keys. Once it changes the cell, there's nothing to redo (saving it would
   * be a new change), and undo undoes the edit: settles it (see `settle`),
   * and undoes it if it was saved, so it can be redone.
   */
  undoOrRedo: (direction: HistoryDirection) => void;
  /**
   * Finishes the edit, keeping its cell active: saves it, as leaving the
   * cell would, or if it can't be saved, drops it, as Escape does. Whether
   * it was saved.
   */
  settle: () => boolean;
};

/**
 * Whether undo and redo from outside the cells can do anything, given
 * whether an edit has changed its cell, and whether the table has a change
 * to undo and one to redo. With no edit, or one that leaves the cell as it
 * was, they're the table's.
 */
export function historyAvailable(modified: boolean, table: { canUndo: boolean; canRedo: boolean }) {
  return { canUndo: modified || table.canUndo, canRedo: !modified && table.canRedo };
}
