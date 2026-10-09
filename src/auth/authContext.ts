import { createContext } from "react";
import type { LoginErrorCode } from "../api/auth.ts";
import type { Session } from "../lib/session.ts";

export type AuthState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "authenticated"; session: Session };

export type LoginOutcome =
  /**
   * `persisted` is whether the session will be restored on the next visit.
   * It's false when not asked to persist, and also when saving failed (e.g.
   * IndexedDB is blocked or full); the user is logged in either way.
   */
  { success: true; persisted: boolean } | { success: false; code: LoginErrorCode };

export type LoginOptions = { persist: boolean };

export type AuthContextValue = {
  state: AuthState;
  /**
   * Logs in. With `persist` the session is saved to IndexedDB and restored
   * on the next visit; otherwise it only lives until the page is closed.
   * Network failures throw; storage failures don't (see LoginOutcome).
   */
  login: (username: string, password: string, options: LoginOptions) => Promise<LoginOutcome>;
};

export const AuthContext = createContext<AuthContextValue | null>(null);
