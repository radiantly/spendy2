import { createContext } from "react";
import type { UploadResult } from "../api/database.ts";
import type { Database } from "./database.ts";

export type DatabaseState =
  | { status: "loading" }
  | { status: "ready"; database: Database }
  | { status: "error"; error: unknown };

export type DatabaseContextValue = {
  state: DatabaseState;
  /** Whether there are changes that `save()` hasn't uploaded yet. */
  dirty: boolean;
  saving: boolean;
  /** Call after every write to the database. */
  markDirty: () => void;
  /**
   * Uploads the database. Edits made while it runs stay unsaved. Returns
   * null when there's no open database; network failures throw.
   */
  save: () => Promise<UploadResult | null>;
  /** Tries to open the database again after an error. */
  retry: () => void;
};

export const DatabaseContext = createContext<DatabaseContextValue | null>(null);
