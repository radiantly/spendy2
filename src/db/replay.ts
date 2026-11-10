/**
 * Making a database from what's stored: a chain of encrypted parts (see
 * parts.ts), an SQLite file and then a changeset for each save after the
 * first.
 *
 * Takes the migrations rather than importing the app's list, which only
 * Vite can bundle, so the scripts can make the same database from the same
 * parts (see scripts/localDatabase.ts).
 */
import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { applyChanges } from "./changes.ts";
import { configureConnection } from "./connection.ts";
import { migrate, type Migration } from "./migrate.ts";
import { decryptPart, readChain } from "./parts.ts";

/**
 * Makes schema `schema` of `db` hold the SQLite file `bytes`, in memory:
 * `main`, or a schema attached as `:memory:`.
 */
export function load(
  sqlite3: Sqlite3Static,
  db: Database,
  schema: string,
  bytes: Uint8Array<ArrayBuffer>,
) {
  // sqlite takes ownership of the buffer: it frees it on close and may
  // reallocate it as the database grows.
  const pointer = sqlite3.wasm.allocFromTypedArray(bytes);
  db.checkRc(
    sqlite3.capi.sqlite3_deserialize(
      db,
      schema,
      pointer,
      bytes.byteLength,
      bytes.byteLength,
      sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE,
    ),
  );
}

/** A new database holding the SQLite file `bytes`. */
export function deserialize(sqlite3: Sqlite3Static, bytes: Uint8Array<ArrayBuffer>) {
  const next = new sqlite3.oo1.DB(":memory:");
  try {
    load(sqlite3, next, "main", bytes);
  } catch (error) {
    next.close();
    throw error;
  }
  return next;
}

/**
 * The database a stored chain of parts makes up, brought up to date, and
 * the sha256 of each part, in order. Part 0's SQLite file is migrated to each
 * changeset's user version before that changeset is applied, as it was when
 * the changeset was recorded, and to the latest version after the last.
 *
 * No integrity check: decrypting already rejects a part changed since it
 * was saved, and checking a large database takes a while.
 */
export async function replay(
  sqlite3: Sqlite3Static,
  bytes: Uint8Array<ArrayBuffer>,
  key: CryptoKey,
  migrations: readonly Migration[],
) {
  const parts = await readChain(bytes);
  const [file, ...changesets] = await Promise.all(parts.map((part) => decryptPart(part, key)));

  const next = deserialize(sqlite3, file!);
  try {
    // Unconfigured until the end, as a new database is while it's migrated.
    // Changesets already hold what triggers and foreign key actions did.
    for (const [i, changeset] of changesets.entries()) {
      migrate(next, migrations, parts[i + 1]!.userVersion);
      applyChanges(sqlite3, next, changeset);
    }
    migrate(next, migrations);
    configureConnection(next);
  } catch (error) {
    next.close();
    throw error;
  }
  return { db: next, hashes: parts.map(({ hash }) => hash) };
}

/** A new database, migrated to the latest version. */
export function create(sqlite3: Sqlite3Static, migrations: readonly Migration[]) {
  const next = new sqlite3.oo1.DB(":memory:");
  try {
    migrate(next, migrations);
    configureConnection(next);
  } catch (error) {
    next.close();
    throw error;
  }
  return next;
}
