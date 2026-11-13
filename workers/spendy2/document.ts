/**
 * The app and its OpenAPI document, for vite-plugins/openapi.ts. Only the
 * generator loads this module, in Node at build time: the worker doesn't
 * import it, and couldn't run sqlite-wasm, which the document needs to show
 * the database's tables.
 */
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { migrate } from "../../src/db/migrate.ts";
import { MIGRATIONS } from "../../src/db/migrations.ts";
import { tableStatements } from "../../src/db/schema.ts";
import { openAPIDocumentFor } from "./app.ts";

export { default } from "./app.ts";

/** The tables of a new database, with every migration applied. */
async function databaseTables() {
  const sqlite3 = await sqlite3InitModule();
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    migrate(db, MIGRATIONS);
    return tableStatements(db);
  } finally {
    db.close();
  }
}

export const openAPIDocument = openAPIDocumentFor(await databaseTables());
