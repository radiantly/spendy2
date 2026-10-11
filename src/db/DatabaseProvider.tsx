import { useEffect, useState, type ReactNode } from "react";
import type { Session } from "../lib/session.ts";
import { openDatabase, type Database } from "./database.ts";
import { DatabaseContext, type DatabaseState } from "./databaseContext.ts";

/**
 * Opens the user's database for its children and tracks unsaved changes.
 * The database closes when the provider unmounts or the session changes.
 */
function DatabaseProvider({ session, children }: { session: Session; children: ReactNode }) {
  const [state, setState] = useState<DatabaseState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  // Counting edits rather than a flag keeps edits made during a save unsaved.
  const [editCount, setEditCount] = useState(0);
  const [savedEditCount, setSavedEditCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const dirty = editCount !== savedEditCount;

  useEffect(() => {
    let cancelled = false;
    let opened: Database | undefined;
    openDatabase(session).then(
      (database) => {
        if (cancelled) return database.close();
        opened = database;
        setState({ status: "ready", database });
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: "error", error });
      },
    );
    return () => {
      cancelled = true;
      opened?.close();
    };
  }, [session, attempt]);

  useEffect(() => {
    if (!dirty) return;
    // Browsers show their own "leave site?" prompt; the message can't be customised.
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function save() {
    if (state.status !== "ready") return null;
    const savingEditCount = editCount;
    setSaving(true);
    try {
      const result = await state.database.save();
      if (result.success) setSavedEditCount(savingEditCount);
      return result;
    } finally {
      setSaving(false);
    }
  }

  return (
    <DatabaseContext
      value={{
        state,
        dirty,
        saving,
        markDirty: () => setEditCount((count) => count + 1),
        save,
        retry: () => {
          setState({ status: "loading" });
          setAttempt((count) => count + 1);
        },
      }}
    >
      {children}
    </DatabaseContext>
  );
}

export default DatabaseProvider;
