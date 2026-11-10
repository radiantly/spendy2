/** The API, as the scripts call it with a session from `npm run init-session`. */
import { fail } from "./lib.ts";
import type { Session } from "./userData.ts";

/** Calls `fetch`, failing the script when the server can't be reached. */
export async function send(target: URL, init: RequestInit): Promise<Response> {
  try {
    return await fetch(target, init);
  } catch {
    fail(`Could not reach ${target}`);
  }
}

/**
 * A request for the parts of the session's user's database: all of them,
 * unless `init` says otherwise. Fails the script if the session has ended.
 */
export async function databaseParts(
  { endpoint, token }: Session,
  init: RequestInit = {},
): Promise<Response> {
  const response = await send(new URL("/api/users/me/database/parts", endpoint), {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init.headers },
  });
  if (response.status === 401) fail("The session has ended, run npm run init-session again");
  return response;
}
