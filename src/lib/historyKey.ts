/** Which way through the history a key goes. */
export type HistoryDirection = "undo" | "redo";

type Keys = { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean };

/**
 * Ctrl+Z (Cmd+Z on a Mac) undoes. Ctrl+Y and Ctrl+Shift+Z redo, and
 * Cmd+Shift+Z on a Mac.
 */
export function historyKey(event: Keys): HistoryDirection | null {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y" && !event.shiftKey) return "redo";
  return null;
}
