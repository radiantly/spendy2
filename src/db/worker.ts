/**
 * Web worker that owns the SQLite database, so queries, (de)compression and
 * encryption never block the main thread. The database lives in memory; it is
 * only persisted by exporting it and uploading the encrypted blob.
 *
 * Writes are recorded (see changes.ts), so they can be undone and redone, and
 * so it's known whether the database differs from the version last saved.
 */
import sqlite3InitModule, { type BindingSpec, type Database } from "@sqlite.org/sqlite-wasm";
import { decryptDatabase, encryptDatabase } from "./blob.ts";
import { applyChanges, invert, Session } from "./changes.ts";
import { configureConnection } from "./connection.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.ts";
import { expose, transfer, type WorkerScope } from "./rpc.ts";

const sqlite3Promise = sqlite3InitModule();

export type Statement = { sql: string; bind?: BindingSpec };

let db: Database | undefined;
let kek: CryptoKey | undefined;
/** The changes since the version last saved (or opened). */
let baseline: Session | undefined;
/**
 * The changes since the version being saved was exported. Replaces
 * `baseline` once that version is saved.
 */
let pendingBaseline: Session | undefined;

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
  pendingBaseline?.end();
  baseline?.end();
  db?.close();
  pendingBaseline = baseline = db = undefined;
}

const api = {
  /**
   * Opens the downloaded blob, or creates a new database when there is none,
   * then brings the schema up to date. Replaces any open database.
   */
  async open(blob: Uint8Array<ArrayBuffer> | null, key: CryptoKey) {
    const sqlite3 = await sqlite3Promise;
    const bytes = blob === null ? null : await decryptDatabase(blob, key);

    const next = new sqlite3.oo1.DB(":memory:");
    try {
      if (bytes !== null) {
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
            sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE |
              sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE,
          ),
        );
        // No integrity check: decrypting already rejects a blob changed since
        // it was saved, and checking a large database takes a while.
      }
      migrate(next, MIGRATIONS);
      configureConnection(next);
    } catch (error) {
      next.close();
      throw error;
    }

    closeDb();
    db = next;
    kek = key;
    baseline = new Session(sqlite3, next);
    return { created: bytes === null };
  },

  /**
   * The open database as an encrypted blob, ready to upload. Call
   * `finishSave` once the upload is done.
   */
  async export() {
    const sqlite3 = await sqlite3Promise;
    const current = openDb();
    // Snapshot synchronously, before any later query can change it, and
    // record changes from exactly there.
    const bytes = sqlite3.capi.sqlite3_js_db_export(current);
    pendingBaseline?.end();
    const pending = new Session(sqlite3, current);
    pendingBaseline = pending;
    try {
      return transfer(await encryptDatabase(bytes, kek!));
    } catch (error) {
      // Nothing will be saved, so nothing is counted from it.
      if (pendingBaseline === pending) {
        pending.end();
        pendingBaseline = undefined;
      }
      throw error;
    }
  },

  /**
   * After uploading the last export: if it was `saved`, changes are counted
   * from it from now on. Returns whether there are unsaved changes.
   */
  async finishSave(saved: boolean) {
    openDb();
    if (saved && pendingBaseline) {
      baseline!.end();
      baseline = pendingBaseline;
    } else pendingBaseline?.end();
    pendingBaseline = undefined;
    return { unsaved: unsaved() };
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
    kek = undefined;
  },
};

export type DatabaseApi = typeof api;

// The DOM lib types `self` as a Window; in a worker it is the worker scope.
expose(api, self as unknown as WorkerScope);
