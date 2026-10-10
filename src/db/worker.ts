/**
 * Web worker that owns the SQLite database, so queries, (de)compression and
 * encryption never block the main thread. The database lives in memory; it is
 * only persisted by exporting it and uploading the encrypted blob.
 */
import sqlite3InitModule, { type BindingSpec, type Database } from "@sqlite.org/sqlite-wasm";
import { decryptDatabase, encryptDatabase } from "./blob.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.ts";
import { expose, transfer, type WorkerScope } from "./rpc.ts";

const sqlite3Promise = sqlite3InitModule();

let db: Database | undefined;
let kek: CryptoKey | undefined;

function openDb() {
  if (db === undefined) throw new Error("The database isn't open");
  return db;
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
        const integrity = next.selectValue("PRAGMA integrity_check");
        if (integrity !== "ok") throw new Error(`The database is corrupt: ${String(integrity)}`);
      }
      migrate(next, MIGRATIONS);
      next.exec("PRAGMA foreign_keys = ON");
    } catch (error) {
      next.close();
      throw error;
    }

    db?.close();
    db = next;
    kek = key;
    return { created: bytes === null };
  },

  /** The open database as an encrypted blob, ready to upload. */
  async export() {
    const sqlite3 = await sqlite3Promise;
    const current = openDb();
    // Snapshot synchronously, before any later query can change it.
    const bytes = sqlite3.capi.sqlite3_js_db_export(current);
    return transfer(await encryptDatabase(bytes, kek!));
  },

  /** Runs one statement and returns its rows as objects. */
  async query(sql: string, bind?: BindingSpec) {
    return openDb().selectObjects(sql, bind);
  },

  async close() {
    db?.close();
    db = undefined;
    kek = undefined;
  },
};

export type DatabaseApi = typeof api;

// The DOM lib types `self` as a Window; in a worker it is the worker scope.
expose(api, self as unknown as WorkerScope);
