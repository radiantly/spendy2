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
import { watchDatabase } from "../api/databaseUpdates.ts";
import { saveRowNumberDigits, type Session } from "../lib/session.ts";
import { DatabaseOpenError, openDatabase, type Database } from "./database.ts";
import { DatabaseContext, type DatabaseState } from "./databaseContext.ts";
import { EditHistory } from "./editHistory.ts";
import { COUNT_TRANSACTIONS } from "./queries/transactions.ts";
import { createQueryClient, databaseKey, refreshAfterWrites } from "./queryClient.ts";
import { RemoteError } from "./rpc.ts";
import { keepTransactionsInSync } from "./transactions.ts";

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
 * What's saved elsewhere (another tab or device) is brought in as soon as
 * the server says, with the unsaved changes moved onto it (see
 * `Database.catchUp`), even while a cell is being edited: what's shown
 * follows its transactions. `onUpdated` is called each time something is
 * brought in, by this or by a save, and `onUpdateFailed` when it can't be:
 * the unsaved changes change what was changed there too, or a newer
 * version of the app saved it.
 *
 * `onSessionEnded` is called when the server no longer accepts `session`:
 * on opening, or later while there's nothing to lose (no unsaved changes,
 * and no save running). With unsaved changes, it's left for saving to
 * report.
 */
function DatabaseProvider({
  session,
  onSessionEnded,
  onUpdated,
  onUpdateFailed,
  children,
}: {
  session: Session;
  onSessionEnded: () => void;
  onUpdated?: () => void;
  onUpdateFailed?: () => void;
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

  // Whether a save is running. Set as soon as one starts, so what the
  // server says before the next render sees it.
  const savingRef = useRef(false);
  useLayoutEffect(() => {
    savingRef.current = saving;
  });
  const sessionEnded = useEffectEvent(() => onSessionEnded());
  const updated = useEffectEvent(() => onUpdated?.());
  const updateFailed = useEffectEvent(() => onUpdateFailed?.());

  useEffect(() => {
    let cancelled = false;
    let stopWatching: (() => void) | undefined;
    let stopRetrying: (() => void) | undefined;
    // The last part the server said, while the unsaved changes conflict with
    // what was saved up to it: tried again as they change, as undoing what
    // conflicted lets it through.
    let behind: { sha256: string | null } | null = null;
    // The database itself knows of unsaved changes as soon as they're made.
    const nothingToLose = (database: Database) =>
      !cancelled && !database.unsaved && !savingRef.current;

    /** Brings in what was saved elsewhere into `database`, the server saying its last part is `sha256`. */
    async function catchUp(database: Database, sha256: string | null) {
      try {
        const result = await database.catchUp(sha256);
        if (cancelled) return;
        if (result.success) {
          behind = null;
          return;
        }
        // Only a reload brings the newer app a newer version needs.
        if (result.code === "CONFLICT") behind = { sha256 };
        if (result.code === "CONFLICT" || result.code === "NEWER_VERSION") updateFailed();
        else if (result.code === "UNAUTHORIZED" && nothingToLose(database)) sessionEnded();
        // A download that failed is tried again on the next update; a save
        // reports any lasting problem.
      } catch (error) {
        // What was saved can't be read (and the network failing is let go).
        if (error instanceof RemoteError && !cancelled) updateFailed();
      }
    }

    openDatabase(session).then(
      (database) => {
        if (cancelled) return database.close();
        setState(ready(database));
        void rememberRowNumberDigits(session.token, countTransactions(database));
        // From when it's open: the server says the last part straight away, so
        // anything saved while it opened is brought in.
        stopWatching = watchDatabase(session.username, session.token, {
          onHead: (sha256) => void catchUp(database, sha256),
          onSessionEnded: () => {
            if (nothingToLose(database)) sessionEnded();
          },
        });
        let { version } = database;
        stopRetrying = database.subscribe(() => {
          if (database.version === version) return;
          version = database.version;
          if (behind !== null) void catchUp(database, behind.sha256);
        });
      },
      (error: unknown) => {
        if (cancelled) return;
        if (isSessionEnded(error)) sessionEnded();
        else setState({ status: "error", error });
      },
    );
    return () => {
      cancelled = true;
      stopWatching?.();
      stopRetrying?.();
    };
  }, [session]);

  // While a database is the one shown, what's read from it is kept up to
  // date, and what's brought in from elsewhere is told. It closes, and its
  // data is dropped, once it's no longer the one shown: a new session, or
  // unmounted. This runs after the pages using it have let go of it, so
  // their unfinished reads are already ignored.
  useEffect(() => {
    if (state.status !== "ready") return;
    const { database, history } = state;
    const stopRefreshing = refreshAfterWrites(queryClient, database);
    const stopSyncing = keepTransactionsInSync(queryClient, database, history);
    let { rebases } = database;
    const stopTelling = database.subscribe(() => {
      if (database.rebases === rebases) return;
      rebases = database.rebases;
      updated();
      // What came in may have more (or fewer) of them, as the next load has.
      void rememberRowNumberDigits(session.token, countTransactions(database));
    });
    return () => {
      stopRefreshing();
      stopSyncing();
      stopTelling();
      database.close();
      queryClient.removeQueries({ queryKey: databaseKey(database) });
    };
  }, [state, queryClient, session.token]);

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
        }}
      >
        {children}
      </DatabaseContext>
    </QueryClientProvider>
  );
}

export default DatabaseProvider;
