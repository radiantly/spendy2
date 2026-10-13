import { useEffect, useState, type ReactNode } from "react";
import { loginUser } from "../api/auth.ts";
import { deriveKek } from "../lib/kek.ts";
import {
  clearSession,
  forgetSession,
  loadSession,
  saveSession,
  type Session,
} from "../lib/session.ts";
import {
  AuthContext,
  type AuthState,
  type LoginOptions,
  type LoginOutcome,
} from "./authContext.ts";

/**
 * Saves the session, or with `persist` off clears any session left over from
 * an earlier visit. Returns whether it will be restored next visit. Storage
 * failures are swallowed: the server already accepted the login, so the
 * session still works for this visit.
 */
async function storeSession(session: Session, persist: boolean): Promise<boolean> {
  try {
    await (persist ? saveSession(session) : clearSession());
    return persist;
  } catch {
    // If clearing failed, a leftover session may be restored next visit; but
    // storage that can't be written to almost certainly can't be read either.
    return false;
  }
}

function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    loadSession()
      // IndexedDB can be unavailable (e.g. some private browsing modes);
      // the user can still log in, the session just won't be restored.
      .catch(() => null)
      .then((session) => {
        if (cancelled) return;
        // A login that finished first takes precedence over the stored session.
        setState((prev) =>
          prev.status !== "loading"
            ? prev
            : session
              ? { status: "authenticated", session }
              : { status: "anonymous" },
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function login(
    username: string,
    password: string,
    { persist }: LoginOptions,
  ): Promise<LoginOutcome> {
    const result = await loginUser(username, password);
    if (!result.success) return result;

    const session: Session = {
      username,
      token: result.token,
      kek: await deriveKek(result.exportKey),
    };
    const persisted = await storeSession(session, persist);
    setState({ status: "authenticated", session });
    return { success: true, persisted };
  }

  function endSession(session: Session) {
    setState((prev) =>
      prev.status === "authenticated" && prev.session.token === session.token
        ? { status: "anonymous" }
        : prev,
    );
    // Storage failures leave the session to be restored next visit, where
    // the server turns it away again.
    forgetSession(session.token).catch(() => {});
  }

  return <AuthContext value={{ state, login, endSession }}>{children}</AuthContext>;
}

export default AuthProvider;
