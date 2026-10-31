import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { pollWhileVisible } from "../lib/pollWhileVisible.ts";
import { saveRowNumberDigits, type Session } from "../lib/session.ts";
import { DatabaseOpenError, openDatabase, openNewerDatabase, type Database } from "./database.ts";
import { DatabaseContext, type DatabaseState } from "./databaseContext.ts";
import { EditHistory } from "./editHistory.ts";
import { COUNT_TRANSACTIONS } from "./queries/transactions.ts";
import { createQueryClient, databaseKey, refreshAfterWrites } from "./queryClient.ts";
import { keepTransactionsInSync } from "./transactions.ts";

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

/** How many transactions `database` has, or null if it couldn't say. */
function countTransactions(database: Database) {
  return database.query(COUNT_TRANSACTIONS).then(
    (rows) => Number(rows[0]!.count),
    () => null,
  );
}

/**
 * Keeps how many digits the `counted` transactions have with the session
 * with `token`, for the row numbers' room the next time they load (see
 * session.ts). A failure is let go: they'd take the room they take.
 */
async function rememberRowNumberDigits(token: string, counted: Promise<number | null>) {
  const count = await counted;
  if (count === null) return;
  await saveRowNumberDigits(token, String(count).length).catch(() => {});
}

/**
 * Opens the user's database for its children, and saves it. The database
 * closes when the provider unmounts. What the children read from it is
 * cached (see queryClient.ts), and kept up to date as it changes.
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
  // It begins opening as it's first rendered: a new session gets a new provider.
  const [openingSince] = useState(() => performance.now());
  const [queryClient] = useState(createQueryClient);
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

    /** Shows `database`, as downloaded: the version the next load gets too, unless it's saved first. */
    function show(database: Database) {
      opened = database;
      setState(ready(database));
      void rememberRowNumberDigits(session.token, countTransactions(database));
    }

    async function checkForUpdate() {
      if (checking || !opened || !canReplace()) return;
      checking = true;
      try {
        const newer = await openNewerDatabase(session, opened);
        if (!newer) return;
        // Something changed while it downloaded.
        if (cancelled || !canReplace()) return newer.close();
        show(newer);
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
        show(database);
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
  }, [session]);

  // While a database is the one shown, what's read from it is kept up to
  // date. It closes, and its data is dropped, once it's no longer the one
  // shown: replaced by a newer version or a new session, or unmounted. This
  // runs after the pages using it have let go of it, so their unfinished
  // reads are already ignored.
  useEffect(() => {
    if (state.status !== "ready") return;
    const { database, history } = state;
    const stopRefreshing = refreshAfterWrites(queryClient, database);
    const stopSyncing = keepTransactionsInSync(queryClient, database, history);
    return () => {
      stopRefreshing();
      stopSyncing();
      database.close();
      queryClient.removeQueries({ queryKey: databaseKey(database) });
    };
  }, [state, queryClient]);

  useEffect(() => {
    if (!dirty) return;
    // Browsers show their own "leave site?" prompt; the message can't be customised.
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function save() {
    if (state.status !== "ready") return null;
    const { database } = state;
    savingRef.current = true;
    setSaving(true);
    try {
      // Counted just before it's exported, so as many as are saved.
      const counted = countTransactions(database);
      const result = await database.save();
      if (result.success) void rememberRowNumberDigits(session.token, counted);
      return result;
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
    <QueryClientProvider client={queryClient}>
      <DatabaseContext
        value={{
          state,
          openingSince,
          rowNumberDigits: session.rowNumberDigits ?? null,
          dirty,
          saving,
          save,
          holdUpdates,
        }}
      >
        {children}
      </DatabaseContext>
    </QueryClientProvider>
  );
}

export default DatabaseProvider;
