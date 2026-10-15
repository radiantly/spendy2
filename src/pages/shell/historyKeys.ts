import { useEffect } from "react";
import { toast } from "sonner";
import { matchPath, useLocation } from "react-router";
import type { DatabaseHistory, Edit } from "../../db/databaseContext.ts";
import { ClosedError } from "../../db/rpc.ts";
import { historyKey, type HistoryDirection } from "../../lib/historyKey.ts";

/** The page each kind of edit shows on: undoing it there, it can be seen. */
const SHOWN_ON: Record<Edit["kind"], string> = { transaction: "/transactions" };

/**
 * Undoes or redoes the latest edit. Says what it did when that can't be seen
 * on `pathname`'s page, and if it couldn't be done.
 */
async function travel(history: DatabaseHistory, direction: HistoryDirection, pathname: string) {
  try {
    const moved = await (direction === "undo" ? history.undo() : history.redo());
    if (moved === null) return;
    if (moved.error !== undefined)
      toast.error(
        `Couldn't ${direction} that: ${
          moved.error instanceof Error ? moved.error.message : String(moved.error)
        }`,
      );
    else if (!matchPath(SHOWN_ON[moved.step.about.kind], pathname))
      toast(`${direction === "undo" ? "Undid" : "Redid"} ${moved.step.about.description}`, {
        duration: 3000,
      });
  } catch (error) {
    // The database closed (e.g. on logging out), and the page with it.
    if (!(error instanceof ClosedError)) throw error;
  }
}

/** Where typing goes, so Ctrl+Z there is the field's own undo. */
function isTextField(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.matches("textarea, input:not([type=checkbox], [type=radio])"))
  );
}

/**
 * Ctrl+Z and Ctrl+Y (and the Mac's Cmd+Z and Cmd+Shift+Z) undo and redo
 * edits anywhere on the page, except in text fields, which undo their own
 * typing. Keys something else already handled are left alone.
 */
export function useHistoryKeys(history: DatabaseHistory | null) {
  const { pathname } = useLocation();
  useEffect(() => {
    if (history === null) return;
    const handle = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTextField(event.target)) return;
      const direction = historyKey(event);
      if (direction === null) return;
      event.preventDefault();
      void travel(history, direction, pathname);
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [history, pathname]);
}

/** Undoes or redoes the latest edit, as the keys do on this page. */
export function useUndoRedo(history: DatabaseHistory) {
  const { pathname } = useLocation();
  return (direction: HistoryDirection) => void travel(history, direction, pathname);
}
