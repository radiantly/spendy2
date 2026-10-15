import { useContext, useLayoutEffect } from "react";
import { DatabaseContext, type DatabaseContextValue } from "./databaseContext.ts";

export function useDatabase(): DatabaseContextValue {
  const database = useContext(DatabaseContext);
  if (!database) throw new Error("useDatabase must be used inside <DatabaseProvider>");
  return database;
}

/** For pages that only render once the database is open (see AppShell). */
export function useOpenDatabase() {
  const { state } = useDatabase();
  if (state.status !== "ready") throw new Error("useOpenDatabase needs an open database");
  return { database: state.database, history: state.history };
}

/**
 * Keeps a version saved elsewhere from replacing the open one while `hold`
 * is true. Held as soon as `hold` renders true, before any check can run.
 */
export function useHoldUpdates(hold: boolean) {
  const { holdUpdates } = useDatabase();
  useLayoutEffect(() => (hold ? holdUpdates() : undefined), [hold, holdUpdates]);
}
