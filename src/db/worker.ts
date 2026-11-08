/**
 * Web worker that owns the SQLite database, so queries, (de)compression and
 * encryption never block the main thread. The database lives in memory; it is
 * stored as a chain of encrypted parts (see parts.ts): an SQLite file, then
 * a changeset for each save after the first.
 *
 * Writes are recorded (see changes.ts), so they can be undone and redone, so
 * it's known whether the database differs from the version last saved, and
 * so a save only uploads what changed since.
 */
import sqlite3InitModule, {
  type BindingSpec,
  type Database,
  type Sqlite3Static,
} from "@sqlite.org/sqlite-wasm";
import { NO_PREVIOUS_PART, sha256Hex } from "../../worker/databaseParts.ts";
import { applyChanges, ChangesConflictError, invert, Session } from "./changes.ts";
import { configureConnection } from "./connection.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.ts";
import { decryptPart, encryptPart, readChain } from "./parts.ts";
import { expose, transfer, type WorkerScope } from "./rpc.ts";

const sqlite3Promise = sqlite3InitModule();

export type Statement = { sql: string; bind?: BindingSpec };

let db: Database | undefined;
let kek: CryptoKey | undefined;
/** The sha256 of the stored chain's last part, which the next save follows; null if never saved. */
let head: string | null = null;
/** The changes since the version last saved (or opened). */
let baseline: Session | undefined;
/**
 * The changes since the part being saved was made, and that part's sha256
 * once it's encrypted. They replace `baseline` and `head` once it's saved.
 */
let pending: { baseline: Session; head?: string } | undefined;

function openDb() {
  if (db === undefined) throw new Error("The database isn't open");
  return db;
}

/** Whether the database differs from the version last saved. */
function unsaved() {
  return baseline!.hasChanges();
}

/** Ends the sessions and closes the database; sessions must end first. */
function closeDb() {
  pending?.baseline.end();
  baseline?.end();
  db?.close();
  pending = baseline = db = undefined;
}

/** A new database holding the SQLite file `bytes`. */
function deserialize(sqlite3: Sqlite3Static, bytes: Uint8Array<ArrayBuffer>) {
  const next = new sqlite3.oo1.DB(":memory:");
  try {
    // sqlite takes ownership of the buffer: it frees it on close and may
    // reallocate it as the database grows.
    const pointer = sqlite3.wasm.allocFromTypedArray(bytes);
    next.checkRc(
      sqlite3.capi.sqlite3_deserialize(
        next,
        "main",
        pointer,
        bytes.byteLength,
        bytes.byteLength,
        sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE,
      ),
    );
  } catch (error) {
    next.close();
    throw error;
  }
  return next;
}

/**
 * The database a stored chain of parts makes up, brought up to date, and
 * the sha256 of its last part. Part 0's SQLite file is migrated to each
 * changeset's user version before that changeset is applied, as it was when
 * the changeset was recorded, and to the latest version after the last.
 *
 * No integrity check: decrypting already rejects a part changed since it
 * was saved, and checking a large database takes a while.
 */
async function replay(sqlite3: Sqlite3Static, bytes: Uint8Array<ArrayBuffer>, key: CryptoKey) {
  const parts = await readChain(bytes);
  const [file, ...changesets] = await Promise.all(parts.map((part) => decryptPart(part, key)));

  const next = deserialize(sqlite3, file!);
  try {
    // Unconfigured until the end, as a new database is while it's migrated.
    // Changesets already hold what triggers and foreign key actions did.
    for (const [i, changeset] of changesets.entries()) {
      migrate(next, MIGRATIONS, parts[i + 1]!.userVersion);
      applyChanges(sqlite3, next, changeset);
    }
    migrate(next, MIGRATIONS);
    configureConnection(next);
  } catch (error) {
    next.close();
    throw error;
  }
  return { db: next, head: parts.at(-1)!.hash };
}

/** A new database, migrated to the latest version. */
function create(sqlite3: Sqlite3Static) {
  const next = new sqlite3.oo1.DB(":memory:");
  try {
    migrate(next, MIGRATIONS);
    configureConnection(next);
  } catch (error) {
    next.close();
    throw error;
  }
  return next;
}

const api = {
  /**
   * Opens the downloaded parts, or creates a new database when there are
   * none, brought up to the latest version. Replaces any open database.
   * Returns the sha256 of the last part, null for a new database.
   */
  async open(parts: Uint8Array<ArrayBuffer> | null, key: CryptoKey) {
    const sqlite3 = await sqlite3Promise;
    const opened =
      parts === null ? { db: create(sqlite3), head: null } : await replay(sqlite3, parts, key);

    closeDb();
    db = opened.db;
    head = opened.head;
    kek = key;
    baseline = new Session(sqlite3, opened.db);
    return { created: parts === null, sha256: head };
  },

  /**
   * The next part to upload: the whole database if it was never saved,
   * otherwise the changes since the version last saved. `previous` is the
   * sha256 of the part it follows, null for part 0. Null if there's nothing
   * to save. Call `finishSave` once the upload is done.
   */
  async prepareSave() {
    const sqlite3 = await sqlite3Promise;
    const current = openDb();
    const previous = head;
    // Taken synchronously, before any later query can change the database,
    // and changes are recorded from exactly there.
    const content =
      previous === null ? sqlite3.capi.sqlite3_js_db_export(current) : baseline!.changes();
    if (previous !== null && content.length === 0) return null;
    const userVersion = Number(current.selectValue("PRAGMA user_version"));
    pending?.baseline.end();
    const started = new Session(sqlite3, current);
    pending = { baseline: started };

    try {
      const part = await encryptPart(content, kek!, {
        previousHash: previous ?? NO_PREVIOUS_PART,
        userVersion,
      });
      // Before the part is transferred, which empties it.
      const sha256 = await sha256Hex(part);
      if (pending?.baseline === started) pending.head = sha256;
      return { part: transfer(part), previous };
    } catch (error) {
      // Nothing will be saved, so nothing is counted from it.
      if (pending?.baseline === started) {
        started.end();
        pending = undefined;
      }
      throw error;
    }
  },

  /**
   * After uploading the last part `prepareSave` made: if it was `saved`,
   * changes are counted from it from now on, and the next save follows it.
   * Returns whether there are unsaved changes, and the sha256 of the last
   * part saved.
   */
  async finishSave(saved: boolean) {
    openDb();
    if (saved && pending?.head !== undefined) {
      baseline!.end();
      baseline = pending.baseline;
      head = pending.head;
    } else pending?.baseline.end();
    pending = undefined;
    return { unsaved: unsaved(), sha256: head };
  },

  /**
   * Moves the unsaved changes onto `parts`, a newer stored version, so the
   * next save follows it. If they don't fit it (they change what was
   * changed there too), nothing changes and `rebased` is false.
   *
   * Every unsaved change moves, also those made while the parts were read:
   * nothing awaits once they're taken.
   */
  async rebase(parts: Uint8Array<ArrayBuffer>) {
    const sqlite3 = await sqlite3Promise;
    openDb();
    const next = await replay(sqlite3, parts, kek!);

    const nextBaseline = new Session(sqlite3, next.db);
    try {
      applyChanges(sqlite3, next.db, baseline!.changes());
    } catch (error) {
      nextBaseline.end();
      next.db.close();
      if (error instanceof ChangesConflictError)
        return { rebased: false as const, unsaved: unsaved() };
      throw error;
    }

    closeDb();
    db = next.db;
    head = next.head;
    baseline = nextBaseline;
    return { rebased: true as const, unsaved: unsaved(), sha256: next.head };
  },

  /**
   * The open database as an SQLite file, unsaved changes and all, for the
   * user to keep. Unencrypted, and nothing to do with saving.
   */
  async serialize() {
    const sqlite3 = await sqlite3Promise;
    return transfer(sqlite3.capi.sqlite3_js_db_export(openDb()));
  },

  /** Runs one statement and returns its rows as objects. */
  async query(sql: string, bind?: BindingSpec) {
    return openDb().selectObjects(sql, bind);
  },

  /**
   * Runs the statements in one transaction: all of them, or none if one
   * fails. Returns the changes they made, for `undo` and `redo`, and
   * whether there are unsaved changes.
   */
  async batch(statements: Statement[]) {
    const sqlite3 = await sqlite3Promise;
    const current = openDb();
    const session = new Session(sqlite3, current);
    try {
      current.transaction(() => {
        for (const { sql, bind } of statements) current.exec({ sql, bind });
      });
      return { changes: session.changes(), unsaved: unsaved() };
    } finally {
      session.end();
    }
  },

  /** Whether there are unsaved changes. */
  async status() {
    openDb();
    return { unsaved: unsaved() };
  },

  /** Undoes `changes` from `batch`. Returns whether there are unsaved changes. */
  async undo(changes: Uint8Array) {
    const sqlite3 = await sqlite3Promise;
    const current = openDb();
    applyChanges(sqlite3, current, invert(sqlite3, current, changes));
    return { unsaved: unsaved() };
  },

  /** Makes `changes` from `batch` again. Returns whether there are unsaved changes. */
  async redo(changes: Uint8Array) {
    const sqlite3 = await sqlite3Promise;
    applyChanges(sqlite3, openDb(), changes);
    return { unsaved: unsaved() };
  },

  async close() {
    closeDb();
    head = null;
    kek = undefined;
  },
};

export type DatabaseApi = typeof api;

// The DOM lib types `self` as a Window; in a worker it is the worker scope.
expose(api, self as unknown as WorkerScope);
