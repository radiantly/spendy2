/**
 * Downloads a user's database into their directory as `database.sqlite3`,
 * to read and change with whatever they like (see localDatabase.ts). Run
 * again, it brings the file up to date, moving what was changed in it
 * since onto the newer version, as the app does with unsaved changes. A
 * user with no database yet gets a new, empty one, stored too.
 *
 * A `database.sqlite3` that can't be moved over is kept, as
 * `database.old.N.sqlite3`, and written anew: when its changes don't fit
 * the newer version, or when the stored database was replaced by another.
 *
 *   npm run pull-database -- [--user <name>]
 */
import fs from "fs";
import { intro, log, outro } from "@clack/prompts";
import type { Database } from "@sqlite.org/sqlite-wasm";
import { applyChanges, ChangesConflictError } from "../src/db/changes.ts";
import { DatabaseTooNewError } from "../src/db/migrate.ts";
import { DatabasePartError, encryptPart, readChain } from "../src/db/parts.ts";
import { create, replay } from "../src/db/replay.ts";
import { databaseEtagSchema } from "../worker/schemas.ts";
import { NO_PREVIOUS_PART, type DatabasePart } from "../worker/databaseParts.ts";
import { databaseParts } from "./api.ts";
import { parseFlags } from "./flags.ts";
import { fail } from "./lib.ts";
import {
  databasePath,
  localChanges,
  LocalDatabaseError,
  readParts,
  shelveDatabase,
  writeLocal,
} from "./localDatabase.ts";
import { MIGRATIONS, sqlite3 } from "./sqlite.ts";
import { userData, type Session } from "./userData.ts";

/** The parts `bytes` holds, or undefined if they aren't a chain of parts. */
async function chainOf(bytes: Uint8Array<ArrayBuffer>): Promise<DatabasePart[] | undefined> {
  try {
    return await readChain(bytes);
  } catch (error) {
    if (error instanceof DatabasePartError) return undefined;
    throw error;
  }
}

/** Stores a new, empty database, unless one was stored meanwhile. */
async function storeNewDatabase(session: Session) {
  const db = create(sqlite3, MIGRATIONS);
  const userVersion = Number(db.selectValue("PRAGMA user_version"));
  const bytes = sqlite3.capi.sqlite3_js_db_export(db);
  db.close();

  const upload = await databaseParts(session, {
    method: "PUT",
    headers: { "If-None-Match": "*" },
    body: await encryptPart(bytes, session.kek, { previousHash: NO_PREVIOUS_PART, userVersion }),
  });
  // 412: stored from elsewhere meanwhile, which is the one to download then.
  if (!upload.ok && upload.status !== 412)
    fail(`Couldn't store a new database: ${upload.status} ${await upload.text()}`);
}

/**
 * The stored parts. `have` is the parts already here: they aren't
 * downloaded again if they're still all there is.
 */
async function download(
  session: Session,
  have: { bytes: Uint8Array<ArrayBuffer>; chain: DatabasePart[] } | undefined,
): Promise<Uint8Array<ArrayBuffer>> {
  const get = () =>
    databaseParts(
      session,
      have && {
        headers: { "If-None-Match": databaseEtagSchema.encode(have.chain.at(-1)!.hash) },
      },
    );

  let response = await get();
  if (response.status === 404) {
    await storeNewDatabase(session);
    response = await get();
  }
  if (response.status === 304 && have) return have.bytes;
  if (!response.ok) fail(`Couldn't download the database: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

const flags = parseFlags({ user: { type: "string" } });

intro("Pull database");

const { directory, session } = await userData(flags.root, flags.user);

const localBytes = readParts(directory);
const localChain = localBytes && (await chainOf(localBytes));
const local = localBytes && localChain && { bytes: localBytes, chain: localChain };

const bytes = await download(session, local);

// Whatever is wrong with what's stored, nothing here is touched over it.
let stored: { db: Database; hashes: string[] };
try {
  stored = await replay(sqlite3, bytes, session.kek, MIGRATIONS);
} catch (error) {
  if (error instanceof DatabaseTooNewError)
    fail(`The stored database is from a newer version of the app: ${error.message}`);
  if (error instanceof DatabasePartError)
    fail(`The stored database can't be read: ${error.message}`);
  if (error instanceof ChangesConflictError)
    fail(`The stored database's parts don't fit each other: ${error.message}`);
  throw error;
}

const follows =
  local !== undefined && local.chain.every((part, i) => part.hash === stored.hashes[i]);
const newParts = follows ? stored.hashes.length - local.chain.length : stored.hashes.length;

/** Why `database.sqlite3` is shelved, or undefined if it's moved over or there is none. */
let shelved: string | undefined;
let kept = false;

if (fs.existsSync(databasePath(directory))) {
  if (!follows) {
    shelved = local
      ? "the stored database was replaced by another"
      : "the parts it was made from are gone";
  } else if (newParts === 0) {
    outro(`${databasePath(directory)} is up to date`);
    process.exit(0);
  } else {
    try {
      const changes = await localChanges(directory, local.bytes, session.kek);
      if (changes.length > 0) {
        // What was made there too is no conflict.
        applyChanges(sqlite3, stored.db, changes, { skipMade: true });
        kept = true;
      }
    } catch (error) {
      if (error instanceof LocalDatabaseError) shelved = error.message;
      else if (error instanceof ChangesConflictError)
        shelved = "its changes don't fit the newer version";
      else throw error;
    }
  }
}

if (shelved !== undefined)
  log.warn(`Kept database.sqlite3 as ${shelveDatabase(directory)}: ${shelved}`);
writeLocal(directory, stored.db, bytes);
stored.db.close();

outro(
  `Pulled ${newParts} new ${newParts === 1 ? "part" : "parts"} into ${databasePath(directory)}` +
    (kept ? ", with your changes on top" : ""),
);
