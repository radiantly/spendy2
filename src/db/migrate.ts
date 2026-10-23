import type { Database } from "@sqlite.org/sqlite-wasm";

/**
 * Schema migrations, tracked with `PRAGMA user_version`.
 *
 * Kept free of Vite-only APIs so the scripts can import it and pass in
 * migrations they read from disk; the app's list lives in migrations.ts.
 */

export type Migration = { version: number; sql: string };

/**
 * Turns `{ ".../3.sql": sql }` into migrations sorted by version. Throws
 * unless the versions are exactly 1..n, so a missing or misnamed file can't
 * silently skip a step.
 */
export function migrationsFromFiles(files: Record<string, string>): Migration[] {
  const migrations = Object.entries(files).map(([path, sql]) => {
    const match = /(?:^|[/\\])(\d+)\.sql$/.exec(path);
    if (!match) throw new Error(`Migration file name must be <version>.sql: ${path}`);
    return { version: Number(match[1]), sql };
  });
  migrations.sort((a, b) => a.version - b.version);

  migrations.forEach(({ version }, i) => {
    if (version !== i + 1)
      throw new Error(`Migrations must be numbered 1..n, expected ${i + 1} but found ${version}`);
  });
  return migrations;
}

export class DatabaseTooNewError extends Error {
  override name = "DatabaseTooNewError";
}

/**
 * Applies every migration newer than the database's `user_version`, each in
 * its own transaction so a failure leaves the database at the last good
 * version. Returns the version before and after.
 *
 * Foreign keys are off while migrating, so a migration can rebuild a table:
 * with them on, dropping it would cascade to the rows referencing it. A
 * migration can't turn them off itself, since the pragma is ignored inside a
 * transaction. Instead, each migration must leave no dangling references,
 * and the setting is restored afterwards.
 *
 * A table is rebuilt without renaming it: create a temporary table, copy the
 * rows into it, drop the table, create it again with its own name, copy the
 * rows back and drop the temporary table. Then recreate the table's indexes
 * and triggers, which were dropped with it. Renaming a table rewrites every
 * reference to it, quoting the name, and the rename fails while a view or
 * trigger refers to a dropped table. Without one, what refers to the table
 * finds it again by name, and the API docs show its statement as written.
 */
export function migrate(db: Database, migrations: readonly Migration[]) {
  const from = Number(db.selectValue("PRAGMA user_version"));
  const latest = migrations.at(-1)?.version ?? 0;
  if (from > latest)
    throw new DatabaseTooNewError(
      `The database is at version ${from}, but this app only knows up to ${latest}`,
    );

  const foreignKeys = Number(db.selectValue("PRAGMA foreign_keys"));
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    for (const { version, sql } of migrations) {
      if (version <= from) continue;
      db.transaction((tx) => {
        tx.exec(sql);
        const violations = tx.selectObjects("PRAGMA foreign_key_check");
        if (violations.length > 0)
          throw new Error(
            `Migration ${version} leaves ${violations.length} broken foreign key reference(s), the first in ${String(violations[0]!.table)}`,
          );
        // PRAGMA doesn't accept bound parameters; version is a parsed integer.
        tx.exec(`PRAGMA user_version = ${version}`);
      });
    }
  } finally {
    db.exec(`PRAGMA foreign_keys = ${foreignKeys}`);
  }

  return { from, to: Math.max(from, latest) };
}
