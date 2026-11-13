/**
 * A user's database on this machine, in their directory (see userData.ts):
 *
 * - `database-parts`: the stored chain of parts, as last downloaded, still
 *   encrypted. It's what the server had then.
 * - `database.sqlite3`: the database those parts make, for the user to read
 *   and change with whatever they like.
 *
 * So how `database.sqlite3` differs from what `database-parts` makes is what
 * the user changed since: `npm run pull-database` moves it onto newer parts,
 * and `npm run push-database` uploads it.
 */
import fs from "fs";
import path from "path";
import type { Database } from "@sqlite.org/sqlite-wasm";
import { difference } from "../../src/db/changes.ts";
import { DatabaseTooNewError, migrate } from "../../src/db/migrate.ts";
import { deserialize, load, replay } from "../../src/db/replay.ts";
import { fail } from "./lib.ts";
import { MIGRATIONS, sqlite3 } from "./sqlite.ts";

const PARTS_FILE = "database-parts";
const DATABASE_FILE = "database.sqlite3";

/** Why `database.sqlite3` can't be compared with the parts it was made from. */
export class LocalDatabaseError extends Error {
  override name = "LocalDatabaseError";
}

export function partsPath(directory: string) {
  return path.join(directory, PARTS_FILE);
}

export function databasePath(directory: string) {
  return path.join(directory, DATABASE_FILE);
}

function readIfThere(file: string): Uint8Array<ArrayBuffer> | undefined {
  if (!fs.existsSync(file)) return undefined;
  return new Uint8Array(fs.readFileSync(file));
}

/** The parts last downloaded, or undefined if none were. */
export function readParts(directory: string) {
  return readIfThere(partsPath(directory));
}

/** Writes `bytes` to `file` whole, or not at all: a crash can't leave half of it. */
function writeWhole(file: string, bytes: Uint8Array) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, bytes);
  fs.renameSync(temporary, file);
}

/**
 * Keeps `db` as `database.sqlite3` and `parts` as the parts it was made
 * from.
 *
 * The database first: if only it gets written, it differs from the older
 * parts by what the newer ones changed, which the next pull finds already
 * made. The other way round, it would differ by those changes undone, and
 * the next push would undo them for everyone.
 */
export function writeLocal(directory: string, db: Database, parts: Uint8Array) {
  writeWhole(databasePath(directory), sqlite3.capi.sqlite3_js_db_export(db));
  writeWhole(partsPath(directory), parts);
}

/**
 * Keeps `part` as the last of the parts `database.sqlite3` was made from,
 * `parts` being the ones before it: once it's stored, what it holds is no
 * longer a change only made here.
 */
export function appendPart(directory: string, parts: Uint8Array, part: Uint8Array) {
  const all = new Uint8Array(parts.length + part.length);
  all.set(parts);
  all.set(part, parts.length);
  writeWhole(partsPath(directory), all);
}

/**
 * Moves `database.sqlite3` out of the way, to the first `database.old.N.sqlite3`
 * there isn't yet. Returns the new name.
 */
export function shelveDatabase(directory: string): string {
  for (let n = 1; ; n++) {
    const name = `database.old.${n}.sqlite3`;
    if (fs.existsSync(path.join(directory, name))) continue;
    fs.renameSync(databasePath(directory), path.join(directory, name));
    return name;
  }
}

/** A database's tables, indexes, triggers and views, as it defines them. */
function schemaOf(db: Database, schema: string) {
  return JSON.stringify(
    db.selectArrays(
      `SELECT type, name, tbl_name, sql FROM ${schema}.sqlite_schema ORDER BY type, name`,
    ),
  );
}

/**
 * `database.sqlite3` as a database in memory, brought up to the latest
 * version. Fails the script if another program still has changes to it
 * that aren't in the file, or if it's from a newer version of the app.
 */
function openDatabaseFile(directory: string): Database {
  const file = databasePath(directory);
  // In WAL mode, changes are in the -wal file until they're checkpointed.
  const wal = `${file}-wal`;
  if (fs.existsSync(wal) && fs.statSync(wal).size > 0)
    fail(`${wal} holds changes that aren't in ${DATABASE_FILE} yet: close what has it open`);

  const bytes = new Uint8Array(fs.readFileSync(file));
  // A file left in WAL mode can't be opened in memory. With no -wal file it
  // holds everything, so it's read as one in rollback mode: the header's
  // read and write versions, 2 for WAL (https://sqlite.org/fileformat.html).
  if (bytes.length >= 20 && bytes[18] === 2 && bytes[19] === 2) bytes[18] = bytes[19] = 1;

  let db: Database;
  try {
    db = deserialize(sqlite3, bytes);
    // Reading the schema is what finds a file that isn't a database.
    db.selectValue("SELECT count(*) FROM sqlite_schema");
  } catch {
    throw new LocalDatabaseError(`${DATABASE_FILE} isn't an SQLite database`);
  }
  try {
    migrate(db, MIGRATIONS);
  } catch (error) {
    db.close();
    if (error instanceof DatabaseTooNewError)
      fail(`${DATABASE_FILE} is from a newer version of the app: ${error.message}`);
    throw new LocalDatabaseError(`${DATABASE_FILE} couldn't be brought up to date`);
  }
  return db;
}

/**
 * What the user changed in `database.sqlite3` since `parts`, the parts it
 * was made from: empty if nothing. Throws a LocalDatabaseError if the two
 * can't be compared. They're compared at the latest version, both brought up
 * to it, so that's the version the changes are written at.
 */
export async function localChanges(
  directory: string,
  parts: Uint8Array<ArrayBuffer>,
  kek: CryptoKey,
): Promise<Uint8Array<ArrayBuffer>> {
  let made;
  try {
    made = await replay(sqlite3, parts, kek, MIGRATIONS);
  } catch (error) {
    if (error instanceof DatabaseTooNewError)
      fail(`${PARTS_FILE} is from a newer version of the app: ${error.message}`);
    throw new LocalDatabaseError(`${PARTS_FILE} can't be read`);
  }
  const before = sqlite3.capi.sqlite3_js_db_export(made.db);
  made.db.close();

  const db = openDatabaseFile(directory);
  try {
    db.exec("ATTACH ':memory:' AS made");
    load(sqlite3, db, "made", before);
    // Changes to rows are all that parts hold after the first.
    if (schemaOf(db, "main") !== schemaOf(db, "made"))
      throw new LocalDatabaseError(`${DATABASE_FILE}'s tables, indexes or triggers were changed`);
    return difference(sqlite3, db, "made");
  } finally {
    db.close();
  }
}
