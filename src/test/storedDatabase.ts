/**
 * A logged-in user with a stored database, for page tests. The test file
 * must mock `src/api/database.ts`:
 *
 *   vi.mock("../../api/database.ts", () => ({
 *     downloadDatabase: vi.fn(),
 *     downloadDatabaseIfChanged: vi.fn(),
 *     replaceDatabase: vi.fn(),
 *     appendDatabasePart: vi.fn(),
 *   }));
 */
import { vi } from "vitest";
import { sha256Hex } from "../../worker/databaseParts.ts";
import {
  appendDatabasePart,
  downloadDatabase,
  downloadDatabaseIfChanged,
  replaceDatabase,
} from "../api/database.ts";
import { openDatabase } from "../db/database.ts";
import { deriveKek } from "../lib/kek.ts";
import { saveSession, type Session } from "../lib/session.ts";
import { EXPORT_KEY, TOKEN } from "./fixtures.ts";

/** A stored database: its parts, one after the other, and the last one's sha256. */
export type StoredDatabase = { parts: Uint8Array<ArrayBuffer>; sha256: string };

/** What an upload's mock answers: the database ignores the hash, working out its own. */
export const UPLOADED = { success: true, sha256: "0".repeat(64) } as const;

export async function session(): Promise<Session> {
  return { username: "alice", token: TOKEN, kek: await deriveKek(EXPORT_KEY) };
}

/** Builds a stored database, of one part, by running `sql` on a new database. */
export async function storedDatabase(sql: string): Promise<StoredDatabase> {
  vi.mocked(downloadDatabase).mockResolvedValueOnce({ success: false, code: "NOT_FOUND" });
  vi.mocked(replaceDatabase).mockResolvedValueOnce(UPLOADED);
  const db = await openDatabase(await session());
  for (const statement of sql.split(";").filter((s) => s.trim())) await db.query(statement);
  await db.save();
  const [, parts] = vi.mocked(replaceDatabase).mock.calls.at(-1)!;
  db.close();
  vi.mocked(replaceDatabase).mockClear();
  return { parts, sha256: await sha256Hex(parts) };
}

/** `stored` after `part`, a part uploaded after its last. */
export async function withPart(
  stored: StoredDatabase,
  part: Uint8Array<ArrayBuffer>,
): Promise<StoredDatabase> {
  const parts = new Uint8Array(stored.parts.length + part.length);
  parts.set(stored.parts);
  parts.set(part, stored.parts.length);
  return { parts, sha256: await sha256Hex(part) };
}

/** The download of `stored`; a copy each time, as opening it hands it to the worker. */
export function downloadOf(stored: StoredDatabase) {
  return { success: true, parts: stored.parts.slice(), sha256: stored.sha256 } as const;
}

/** The database the mocked API serves, or null for none: see `serve`. */
let served: StoredDatabase | null = null;

/**
 * Logs in, with `stored` as the user's database, or none. The mocked API
 * serves it, and saves change it (see `serve`).
 */
export async function loggedIn(stored: StoredDatabase | null) {
  await saveSession(await session());
  serve(stored);
}

/**
 * Has the mocked API serve `stored`, or no database, from now on, as the
 * server would: downloads get it, and uploads change it, if their
 * precondition holds. A test can still have a call answer otherwise.
 */
export function serve(stored: StoredDatabase | null) {
  served = stored;
  const notFound = { success: false, code: "NOT_FOUND" } as const;
  const conflict = { success: false, code: "CONFLICT" } as const;
  vi.mocked(downloadDatabase).mockImplementation(async () =>
    served === null ? notFound : downloadOf(served),
  );
  vi.mocked(downloadDatabaseIfChanged).mockImplementation(async (_token, sha256) => {
    if (served === null) return notFound;
    return sha256 === served.sha256 ? { success: false, code: "NOT_MODIFIED" } : downloadOf(served);
  });
  vi.mocked(replaceDatabase).mockImplementation(async (_token, parts, precondition) => {
    const matches =
      "ifMatch" in precondition ? precondition.ifMatch === served?.sha256 : served === null;
    if (!matches) return conflict;
    // Copied: the caller's array is the part it keeps.
    served = { parts: parts.slice(), sha256: await sha256Hex(parts) };
    return { success: true, sha256: served.sha256 };
  });
  vi.mocked(appendDatabasePart).mockImplementation(async (_token, part, ifMatch) => {
    if (served === null || ifMatch !== served.sha256) return conflict;
    served = await withPart(served, part);
    return { success: true, sha256: served.sha256 };
  });
}

/** The database the mocked API serves now, with what was saved to it. */
export function servedDatabase() {
  return served;
}

/**
 * Runs `sql` on the database the mocked API serves now, and saves it there,
 * as another device would. The mocked API's calls are cleared after, so a
 * test only sees its own.
 */
export async function savedElsewhere(sql: string) {
  const db = await openDatabase(await session());
  try {
    await db.batch(
      sql
        .split(";")
        .filter((s) => s.trim())
        .map((statement) => ({ sql: statement })),
    );
    const result = await db.save();
    if (!result.success) throw new Error(`Couldn't save elsewhere: ${result.code}`);
  } finally {
    db.close();
  }
  for (const api of [
    downloadDatabase,
    downloadDatabaseIfChanged,
    replaceDatabase,
    appendDatabasePart,
  ])
    vi.mocked(api).mockClear();
}

/** Runs `sql` on the database the mocked API serves now. */
export async function querySaved(sql: string) {
  const db = await openDatabase(await session());
  try {
    return await db.query(sql);
  } finally {
    db.close();
  }
}
