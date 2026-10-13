/**
 * A logged-in user with a stored database, for page tests. The test file
 * must mock `src/api/database.ts`:
 *
 *   vi.mock("../../api/database.ts", () => ({
 *     downloadDatabase: vi.fn(),
 *     downloadDatabaseIfChanged: vi.fn(),
 *     uploadDatabase: vi.fn(),
 *   }));
 */
import { vi } from "vitest";
import { downloadDatabase, uploadDatabase } from "../api/database.ts";
import { openDatabase } from "../db/database.ts";
import { deriveKek } from "../lib/kek.ts";
import { saveSession, type Session } from "../lib/session.ts";
import { EXPORT_KEY, TOKEN } from "./fixtures.ts";

/** The sha256 of the stored database `loggedIn` sets up. */
export const SHA_A = "a".repeat(64);
export const SHA_B = "b".repeat(64);

export async function session(): Promise<Session> {
  return { username: "alice", token: TOKEN, kek: await deriveKek(EXPORT_KEY) };
}

/** Builds a stored database blob by running `sql` on a new database. */
export async function storedDatabase(sql: string) {
  vi.mocked(downloadDatabase).mockResolvedValueOnce({ success: false, code: "NOT_FOUND" });
  vi.mocked(uploadDatabase).mockResolvedValueOnce({ success: true, sha256: SHA_A });
  const db = await openDatabase(await session());
  for (const statement of sql.split(";").filter((s) => s.trim())) await db.query(statement);
  await db.save();
  const blob = vi.mocked(uploadDatabase).mock.calls.at(-1)![1];
  db.close();
  vi.mocked(uploadDatabase).mockClear();
  return blob;
}

/** Logs in, with `stored` as the user's database (`SHA_A`), or none. */
export async function loggedIn(stored: Uint8Array<ArrayBuffer> | null) {
  await saveSession(await session());
  if (stored === null)
    vi.mocked(downloadDatabase).mockResolvedValue({ success: false, code: "NOT_FOUND" });
  else
    vi.mocked(downloadDatabase).mockResolvedValue({ success: true, blob: stored, sha256: SHA_A });
}
