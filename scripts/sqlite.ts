/** SQLite and the app's migrations, as the scripts get them: under Node, from disk. */
import fs from "fs";
import path from "path";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { migrationsFromFiles } from "../src/db/migrate.ts";

const migrationsDir = path.join(import.meta.dirname, "..", "src", "db", "migrations");

export const MIGRATIONS = migrationsFromFiles(
  Object.fromEntries(
    fs
      .readdirSync(migrationsDir)
      .map((file) => [file, fs.readFileSync(path.join(migrationsDir, file), "utf8")]),
  ),
);

export const sqlite3 = await sqlite3InitModule();
