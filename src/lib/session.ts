import { createStore, del, get, promisifyRequest, set } from "idb-keyval";
import { z } from "zod";
import { usernameSchema } from "../../workers/spendy2/schemas.ts";

/**
 * The persisted login. The KEK is a non-extractable CryptoKey, which
 * IndexedDB can store directly without ever exposing the raw key bytes.
 */
const sessionSchema = z.object({
  username: usernameSchema,
  token: z.string(),
  kek: z.instanceof(CryptoKey),
  /**
   * How many digits the count of transactions had when the database was
   * last opened or saved with this session, so the transactions' loader
   * can give the row numbers as much room as the table will (see
   * TransactionsLoader). Kept with the session, so it goes when the
   * session does. A malformed one is dropped, rather than the session.
   */
  rowNumberDigits: z.number().int().positive().optional().catch(undefined),
});

export type Session = z.infer<typeof sessionSchema>;

const store = createStore("spendy", "session");
const SESSION_KEY = "current";

/** Returns null when there is no session or the stored one is malformed. */
export async function loadSession(): Promise<Session | null> {
  const result = sessionSchema.safeParse(await get(SESSION_KEY, store));
  return result.success ? result.data : null;
}

export function saveSession(session: Session): Promise<void> {
  return set(SESSION_KEY, session, store);
}

export function clearSession(): Promise<void> {
  return del(SESSION_KEY, store);
}

/**
 * Keeps `rowNumberDigits` with the stored session, if it's still the one
 * with `token`: there's none when the login isn't remembered, and another
 * tab may have replaced it with a newer login since. Checked and written in
 * one transaction, so such a login can't come between the two.
 */
export function saveRowNumberDigits(token: string, rowNumberDigits: number): Promise<void> {
  return store(
    "readwrite",
    (sessions) =>
      new Promise<void>((resolve, reject) => {
        const request = sessions.get(SESSION_KEY);
        request.onsuccess = () => {
          const stored = sessionSchema.safeParse(request.result);
          if (stored.success && stored.data.token === token)
            sessions.put({ ...stored.data, rowNumberDigits }, SESSION_KEY);
          resolve(promisifyRequest(sessions.transaction));
        };
        request.onerror = () => reject(request.error);
      }),
  );
}

/**
 * Clears the stored session if it's still the one with `token`; another tab
 * may have replaced it with a newer login since.
 */
export async function forgetSession(token: string): Promise<void> {
  const stored = await loadSession();
  if (stored?.token === token) await clearSession();
}
