/** An SQLite file opened on the test's own thread, to see what's in it. */

import sqlite3InitModule, { type Database } from "@sqlite.org/sqlite-wasm";

const sqlite3Promise = sqlite3InitModule();

/** Opens the bytes of an SQLite file as a database in memory. Close it once done. */
export async function openSqliteFile(bytes: Uint8Array): Promise<Database> {
  const sqlite3 = await sqlite3Promise;
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    // sqlite takes ownership of the copy, and frees it on close.
    const pointer = sqlite3.wasm.allocFromTypedArray(bytes);
    db.checkRc(
      sqlite3.capi.sqlite3_deserialize(
        db,
        "main",
        pointer,
        bytes.byteLength,
        bytes.byteLength,
        sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE,
      ),
    );
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
