import { useContext } from "react";
import { DatabaseContext, type DatabaseContextValue } from "./databaseContext.ts";

export function useDatabase(): DatabaseContextValue {
  const database = useContext(DatabaseContext);
  if (!database) throw new Error("useDatabase must be used inside <DatabaseProvider>");
  return database;
}

/** For pages that only render once the database is open (see AppShell). */
export function useOpenDatabase() {
  const { state, markDirty } = useDatabase();
  if (state.status !== "ready") throw new Error("useOpenDatabase needs an open database");
  return { database: state.database, markDirty };
}
