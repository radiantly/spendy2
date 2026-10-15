import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { pollWhileVisible } from "../lib/pollWhileVisible.ts";
import type { Session } from "../lib/session.ts";
import { DatabaseOpenError, openDatabase, openNewerDatabase, type Database } from "./database.ts";
import { DatabaseContext, type DatabaseState } from "./databaseContext.ts";
import { EditHistory } from "./editHistory.ts";

/** How often to check for a version saved elsewhere (ms), while the page is visible. */
const UPDATE_INTERVAL = 10_000;

/** For `useSyncExternalStore` while there's no database: nothing ever changes. */
const subscribeToNothing = () => () => {};

/** `database`, open, with a history of its own: edits to another version don't apply to it. */
function ready(database: Database): DatabaseState {
  return { status: "ready", database, history: new EditHistory(database) };
}

/** Whether the server turned the session away. */
function isSessionEnded(error: unknown) {
  return error instanceof DatabaseOpenError && error.code === "UNAUTHORIZED";
}

/**
 * Opens the user's database for its children, and saves it. The database
 * closes when the provider unmounts.
 *
 * While there's nothing to lose, a version saved elsewhere (another tab or
 * device) replaces the open one. Nothing is lost when there are no unsaved
 * changes, no save is running, and nothing has asked to hold updates back.
 *
 * `onSessionEnded` is called when the server no longer accepts `session`:
 * on opening, or on checking for a newer version while there's nothing to
 * lose. With unsaved changes, it's left for saving to report.
 */
function DatabaseProvider({
  session,
  onSessionEnded,
  children,
}: {
  session: Session;
  onSessionEnded: () => void;
  children: ReactNode;
}) {
  const [state, setState] = useState<DatabaseState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const database = state.status === "ready" ? state.database : null;
  const dirty = useSyncExternalStore(
    database?.subscribe ?? subscribeToNothing,
    () => database?.unsaved ?? false,
  );

  // Whether a save is running. Set as soon as one starts, so a check
  // finishing before the next render sees it.
  const savingRef = useRef(false);
  useLayoutEffect(() => {
    savingRef.current = saving;
  });
  const holdsRef = useRef(0);
  const sessionEnded = useEffectEvent(() => onSessionEnded());

  useEffect(() => {
    let cancelled = false;
    let opened: Database | undefined;
    let stopPolling: (() => void) | undefined;
    let checking = false;
    // The database itself knows of unsaved changes as soon as they're made.
    const canReplace = () => !opened!.unsaved && !savingRef.current && holdsRef.current === 0;

    async function checkForUpdate() {
      if (checking || !opened || !canReplace()) return;
      checking = true;
      try {
        const newer = await openNewerDatabase(session, opened);
        if (!newer) return;
        // Something changed while it downloaded.
        if (cancelled || !canReplace()) return newer.close();
        opened = newer;
        setState(ready(newer));
      } catch (error) {
        // Logging out now would lose what changed during the check.
        if (isSessionEnded(error) && !cancelled && canReplace()) sessionEnded();
        // Anything else is tried again on the next check; saving reports any lasting problem.
      } finally {
        checking = false;
      }
    }

    openDatabase(session).then(
      (database) => {
        if (cancelled) return database.close();
        opened = database;
        setState(ready(database));
        stopPolling = pollWhileVisible(() => void checkForUpdate(), UPDATE_INTERVAL);
      },
      (error: unknown) => {
        if (cancelled) return;
        if (isSessionEnded(error)) sessionEnded();
        else setState({ status: "error", error });
      },
    );
    return () => {
      cancelled = true;
      stopPolling?.();
    };
  }, [session, attempt]);

  // A database closes once it's no longer the one shown: replaced by a newer
  // version or a new session, or unmounted. This runs after the pages using
  // it have let go of it, so their unfinished reads are already ignored.
  useEffect(() => {
    if (state.status !== "ready") return;
    const { database } = state;
    return () => database.close();
  }, [state]);

  useEffect(() => {
    if (!dirty) return;
    // Browsers show their own "leave site?" prompt; the message can't be customised.
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function save() {
    if (state.status !== "ready") return null;
    savingRef.current = true;
    setSaving(true);
    try {
      return await state.database.save();
    } finally {
      setSaving(false);
    }
  }

  function holdUpdates() {
    holdsRef.current++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holdsRef.current--;
    };
  }

  return (
    <DatabaseContext
      value={{
        state,
        dirty,
        saving,
        save,
        holdUpdates,
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
