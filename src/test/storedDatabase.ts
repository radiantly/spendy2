/**
 * A logged-in user with a stored database, for page tests. The test file
 * must mock `src/api/database.ts` and `src/api/databaseUpdates.ts`:
 *
 *   vi.mock("../../api/database.ts", () => ({
 *     downloadDatabase: vi.fn(),
 *     downloadDatabasePart: vi.fn(),
 *     replaceDatabase: vi.fn(),
 *     appendDatabasePart: vi.fn(),
 *   }));
 *   vi.mock("../../api/databaseUpdates.ts", () => ({ watchDatabase: vi.fn() }));
 */
import { vi } from "vitest";
import { sha256Hex } from "../../workers/spendy2/databaseParts.ts";
import {
  appendDatabasePart,
  downloadDatabase,
  downloadDatabasePart,
  replaceDatabase,
} from "../api/database.ts";
import { watchDatabase, type DatabaseWatcher } from "../api/databaseUpdates.ts";
import { openDatabase } from "../db/database.ts";
import { deriveKek } from "../lib/kek.ts";
import { saveSession, type Session } from "../lib/session.ts";
import { EXPORT_KEY, TOKEN } from "./fixtures.ts";
import { previousHashOf } from "./parts.ts";

/** A stored database: its parts, in order, and the last one's sha256. */
export type StoredDatabase = { parts: readonly Uint8Array<ArrayBuffer>[]; sha256: string };

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
  const [, part] = vi.mocked(replaceDatabase).mock.calls.at(-1)!;
  db.close();
  vi.mocked(replaceDatabase).mockClear();
  return { parts: [part], sha256: await sha256Hex(part) };
}

/** The download of all of `stored`; a copy each time, as opening it hands it to the worker. */
export function downloadOf({ parts, sha256 }: StoredDatabase) {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return { success: true, parts: bytes, sha256 } as const;
}

/** The database the mocked API serves, or null for none: see `serve`. */
let served: StoredDatabase | null = null;
/** What watches it (see `watchDatabase`), told its last part after each upload. */
const watchers = new Set<DatabaseWatcher>();
/** What they'd be told while it's held back (see `savedElsewhere`). */
let heldBack: (() => void)[] | null = null;

/** The last part served, as the server tells what watches it. */
function latestPart() {
  return served === null ? null : { index: served.parts.length - 1, hash: served.sha256 };
}

/** Tells the watchers the last part, as it is now, as the server does after an upload. */
function tellWatchers() {
  const latest = latestPart();
  const tell = () => {
    for (const watcher of watchers) watcher.onLatestPart(latest);
  };
  if (heldBack) heldBack.push(tell);
  // As a message arrives: after whatever's running now.
  else setTimeout(tell);
}

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
 * server would: downloads get it, uploads change it, if their precondition
 * holds, and what watches it is told each time. A test can still have a
 * call answer otherwise.
 */
export function serve(stored: StoredDatabase | null) {
  served = stored;
  watchers.clear();
  const notFound = { success: false, code: "NOT_FOUND" } as const;
  const conflict = { success: false, code: "CONFLICT" } as const;
  vi.mocked(downloadDatabase).mockImplementation(async () =>
    served === null ? notFound : downloadOf(served),
  );
  vi.mocked(downloadDatabasePart).mockImplementation(async (_token, index) => {
    const part = served?.parts[index];
    if (part === undefined) return notFound;
    return { success: true, parts: part.slice(), sha256: await sha256Hex(part) };
  });
  vi.mocked(replaceDatabase).mockImplementation(async (_token, parts, precondition) => {
    const matches =
      "ifMatch" in precondition ? precondition.ifMatch === served?.sha256 : served === null;
    if (!matches) return conflict;
    // Copied: the caller's array is the part it keeps. The app only ever
    // replaces the database with part 0.
    served = { parts: [parts.slice()], sha256: await sha256Hex(parts) };
    tellWatchers();
    return { success: true, sha256: served.sha256 };
  });
  vi.mocked(appendDatabasePart).mockImplementation(async (_token, part) => {
    if (served === null || (await previousHashOf(part)) !== served.sha256) return conflict;
    served = { parts: [...served.parts, part.slice()], sha256: await sha256Hex(part) };
    tellWatchers();
    return { success: true, sha256: served.sha256 };
  });
  vi.mocked(watchDatabase).mockImplementation((_username, _token, watcher) => {
    watchers.add(watcher);
    // As the server does once a socket connects.
    const latest = latestPart();
    setTimeout(() => {
      if (watchers.has(watcher)) watcher.onLatestPart(latest);
    });
    return () => void watchers.delete(watcher);
  });
}

/** The database the mocked API serves now, with what was saved to it. */
export function servedDatabase() {
  return served;
}

/** Ends the session for what watches the database, as the server closing its socket does. */
export function endWatchedSession() {
  for (const watcher of watchers) watcher.onSessionEnded();
  watchers.clear();
}

/**
 * Runs `sql` on the database the mocked API serves now, and saves it there,
 * as another device would. The mocked API's calls are cleared after, so a
 * test only sees its own; what watches the database is told once they are.
 */
export async function savedElsewhere(sql: string) {
  heldBack = [];
  try {
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
    for (const api of [downloadDatabase, downloadDatabasePart, replaceDatabase, appendDatabasePart])
      vi.mocked(api).mockClear();
  } finally {
    const held = heldBack;
    heldBack = null;
    for (const tell of held) tell();
  }
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
