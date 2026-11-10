/**
 * A user's database in the scripts' tests: what the server stores of it,
 * changed as the app would from elsewhere, and the files in the user's
 * directory, changed as the user would with a program of their own.
 */
import fs from "fs";
import path from "path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { inject } from "vitest";
import { Session } from "../../src/db/changes.ts";
import { migrationsFromFiles } from "../../src/db/migrate.ts";
import { encryptPart, readChain } from "../../src/db/parts.ts";
import { replay } from "../../src/db/replay.ts";
import { importKek } from "../../src/lib/kek.ts";
import { sessionEnv, userDirectory } from "./run.ts";

const migrationsDir = path.join(import.meta.dirname, "..", "..", "src", "db", "migrations");
const MIGRATIONS = migrationsFromFiles(
  Object.fromEntries(
    fs
      .readdirSync(migrationsDir)
      .map((file) => [file, fs.readFileSync(path.join(migrationsDir, file), "utf8")]),
  ),
);
export const LATEST_VERSION = MIGRATIONS.at(-1)!.version;

const sqlite3Promise = sqlite3InitModule();

function request(root: string, username: string, init: RequestInit = {}) {
  return fetch(new URL("/api/users/me/database/parts", inject("endpoint")), {
    ...init,
    headers: {
      Authorization: `Bearer ${sessionEnv(root, username).SPENDY2_TOKEN}`,
      ...init.headers,
    },
  });
}

function kekOf(root: string, username: string) {
  return importKek(
    new Uint8Array(Buffer.from(sessionEnv(root, username).SPENDY2_KEK!, "base64url")),
  );
}

/** What the server stores for the user: null if nothing, else all of the parts. */
export async function storedParts(root: string, username: string) {
  const response = await request(root, username);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Couldn't download the parts: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** How many parts the server stores for the user. */
export async function storedPartCount(root: string, username: string) {
  const bytes = await storedParts(root, username);
  return bytes === null ? 0 : (await readChain(bytes)).length;
}

/** What `sql` gives of the database the server stores: each row's values. */
export async function queryStored(root: string, username: string, sql: string) {
  const bytes = await storedParts(root, username);
  if (bytes === null) throw new Error(`${username} has no stored database`);
  const sqlite3 = await sqlite3Promise;
  const { db } = await replay(sqlite3, bytes, await kekOf(root, username), MIGRATIONS);
  try {
    return db.selectArrays(sql);
  } finally {
    db.close();
  }
}

/**
 * Runs `sql` on the stored database and saves it as the app would from
 * elsewhere: what changed, as a part after the last.
 */
export async function saveElsewhere(root: string, username: string, sql: string) {
  const bytes = await storedParts(root, username);
  if (bytes === null) throw new Error(`${username} has no stored database`);
  const sqlite3 = await sqlite3Promise;
  const kek = await kekOf(root, username);
  const { db, hashes } = await replay(sqlite3, bytes, kek, MIGRATIONS);
  let changes;
  const session = new Session(sqlite3, db);
  try {
    db.exec(sql);
    changes = session.changes();
  } finally {
    session.end();
    db.close();
  }

  const response = await request(root, username, {
    method: "POST",
    body: await encryptPart(changes, kek, {
      previousHash: hashes.at(-1)!,
      userVersion: LATEST_VERSION,
    }),
  });
  if (!response.ok)
    throw new Error(`Couldn't save elsewhere: ${response.status} ${await response.text()}`);
}

export function localDatabasePath(root: string, username: string) {
  return path.join(userDirectory(root, username), "database.sqlite3");
}

export function localPartsPath(root: string, username: string) {
  return path.join(userDirectory(root, username), "database-parts");
}

/** Opens a database file as another program would: as a file, with SQLite's own defaults. */
function withFile<T>(file: string, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

/** Runs `sql` on a file in the user's directory, `database.sqlite3` unless named. */
export function editLocal(root: string, username: string, sql: string, name = "database.sqlite3") {
  withFile(path.join(userDirectory(root, username), name), (db) => db.exec(sql));
}

/** What `sql` gives of a file in the user's directory: each row's values. */
export function queryLocal(
  root: string,
  username: string,
  sql: string,
  name = "database.sqlite3",
): SQLOutputValue[][] {
  return withFile(path.join(userDirectory(root, username), name), (db) =>
    db
      .prepare(sql)
      .all()
      .map((row) => Object.values(row)),
  );
}

/** The user's directory's files, in order. */
export function localFiles(root: string, username: string) {
  return fs.readdirSync(userDirectory(root, username)).sort();
}
