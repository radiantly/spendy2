import type { Database } from "@sqlite.org/sqlite-wasm";

/**
 * The CREATE TABLE statements of the database's tables, as SQLite stores
 * them: comments inside a statement are kept, the ones before it aren't.
 * In the order the tables were created, so a table rebuilt by a migration
 * comes after the ones that weren't. SQLite's own tables, like
 * sqlite_sequence, are left out.
 */
export function tableStatements(db: Database) {
  return db
    .selectValues(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY rowid",
    )
    .map(String);
}
