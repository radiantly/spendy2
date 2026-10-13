import { createStore, del, get, set } from "idb-keyval";
import { z } from "zod";
import { usernameSchema } from "../../worker/schemas.ts";

/**
 * The persisted login. The KEK is a non-extractable CryptoKey, which
 * IndexedDB can store directly without ever exposing the raw key bytes.
 */
const sessionSchema = z.object({
  username: usernameSchema,
  token: z.string(),
  kek: z.instanceof(CryptoKey),
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
 * Clears the stored session if it's still the one with `token`; another tab
 * may have replaced it with a newer login since.
 */
export async function forgetSession(token: string): Promise<void> {
  const stored = await loadSession();
  if (stored?.token === token) await clearSession();
}
