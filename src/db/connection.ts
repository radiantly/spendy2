import type { Database } from "@sqlite.org/sqlite-wasm";

/**
 * Applies the settings the schema relies on that SQLite keeps per connection
 * rather than in the file: foreign keys, and recursive triggers so deleting
 * an unused category can delete its unused parents at any depth. Every
 * connection that changes data needs this.
 */
export function configureConnection(db: Database) {
  db.exec("PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON;");
}
