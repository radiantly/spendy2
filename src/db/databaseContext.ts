import { createContext } from "react";
import type { UploadResult } from "../api/database.ts";
import type { Database } from "./database.ts";
import type { EditHistory } from "./editHistory.ts";
import type { EditedCell } from "./queries/transactions.ts";

/** An edit to transactions: the cells it changed, and what it did, in words. */
export type TransactionEdit = {
  kind: "transaction";
  cells: readonly EditedCell[];
  /** What it did, to follow "Undid" or "Redid": "category of Corner Market: Groceries → Coffee". */
  description: string;
};

/** What an edit was, by the kind of thing it changed. */
export type Edit = TransactionEdit;

/** Undo and redo of the edits to the open database. */
export type DatabaseHistory = EditHistory<Edit>;

export type DatabaseState =
  | { status: "loading" }
  | { status: "ready"; database: Database; history: DatabaseHistory }
  | { status: "error"; error: unknown };

export type DatabaseContextValue = {
  state: DatabaseState;
  /** Whether the database differs from the version last saved. */
  dirty: boolean;
  saving: boolean;
  /**
   * Uploads the database. Edits made while it runs stay unsaved. Returns
   * null when there's no open database; network failures throw.
   */
  save: () => Promise<UploadResult | null>;
  /**
   * Keeps a version saved elsewhere from replacing the open one until the
   * returned function is called, for state the replacement would lose.
   */
  holdUpdates: () => () => void;
  /** Tries to open the database again after an error. */
  retry: () => void;
};

export const DatabaseContext = createContext<DatabaseContextValue | null>(null);
