/**
 * Uploads what was changed in a user's `database.sqlite3` since it was
 * pulled (see localDatabase.ts), as the app saves: the changes to its rows,
 * as a part after the last. Changes to its tables, indexes or triggers
 * can't be uploaded.
 *
 * Whatever goes wrong, it stops with nothing changed, here or stored. When
 * the stored database has changed since the pull, pull again first: that
 * moves the changes here onto the newer version.
 *
 *   npm run push-database -- [--user <name>]
 */
import fs from "fs";
import { intro, outro } from "@clack/prompts";
import { DatabasePartError, encryptPart, readChain } from "../src/db/parts.ts";
import type { DatabasePart } from "../workers/spendy2/databaseParts.ts";
import { databaseParts } from "./lib/api.ts";
import { parseFlags } from "./lib/flags.ts";
import { fail } from "./lib/lib.ts";
import {
  appendPart,
  databasePath,
  localChanges,
  LocalDatabaseError,
  partsPath,
  readParts,
} from "./lib/localDatabase.ts";
import { MIGRATIONS } from "./lib/sqlite.ts";
import { userData } from "./lib/userData.ts";

const PULL_FIRST = "run npm run pull-database first";

const flags = parseFlags({ user: { type: "string" } });

intro("Push database");

const { directory, session } = await userData(flags.root, flags.user);

const parts = readParts(directory);
if (parts === undefined || !fs.existsSync(databasePath(directory)))
  fail(`No database in ${directory}, ${PULL_FIRST}`);

let chain: DatabasePart[];
try {
  chain = await readChain(parts);
} catch (error) {
  if (error instanceof DatabasePartError)
    fail(`${partsPath(directory)} can't be read (${error.message}), ${PULL_FIRST}`);
  throw error;
}

let changes;
try {
  changes = await localChanges(directory, parts, session.kek);
} catch (error) {
  if (error instanceof LocalDatabaseError) fail(`Can't push: ${error.message}`);
  throw error;
}
if (changes.length === 0) {
  outro("Nothing to push: database.sqlite3 is as it was pulled");
  process.exit(0);
}

const part = await encryptPart(changes, session.kek, {
  previousHash: chain.at(-1)!.hash,
  // The version `localChanges` compared the two at.
  userVersion: MIGRATIONS.at(-1)!.version,
});
const upload = await databaseParts(session, { method: "POST", body: part });
if (upload.status === 409)
  fail(`The stored database has changed since it was pulled, ${PULL_FIRST}, then push again`);
if (!upload.ok) fail(`Upload failed: ${upload.status} ${await upload.text()}`);

appendPart(directory, parts, part);

outro(`Pushed the changes in ${databasePath(directory)}`);
