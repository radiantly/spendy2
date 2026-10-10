import sqlite3InitModule, { type Database } from "@sqlite.org/sqlite-wasm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseTooNewError, migrate, migrationsFromFiles, type Migration } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.ts";

const sqlite3 = await sqlite3InitModule();

let db: Database;
beforeEach(() => {
  db = new sqlite3.oo1.DB(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
});
afterEach(() => db.close());

const userVersion = () => db.selectValue("PRAGMA user_version");
const tables = () =>
  db.selectValues("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");

describe("migrationsFromFiles", () => {
  it("sorts by the number in the file name, not as text", () => {
    const migrations = migrationsFromFiles(
      Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [`./migrations/${10 - i}.sql`, `-- ${10 - i}`]),
      ),
    );

    expect(migrations.map((m) => m.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("rejects a gap in the numbering", () => {
    expect(() => migrationsFromFiles({ "./1.sql": "", "./3.sql": "" })).toThrow(
      "expected 2 but found 3",
    );
  });

  it("rejects numbering that doesn't start at 1", () => {
    expect(() => migrationsFromFiles({ "./0.sql": "" })).toThrow("expected 1 but found 0");
  });

  it("rejects a file name that isn't a version", () => {
    expect(() => migrationsFromFiles({ "./1-accounts.sql": "" })).toThrow("<version>.sql");
  });

  it("loads the app's migrations", () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(
      Array.from({ length: MIGRATIONS.length }, (_, i) => i + 1),
    );
  });
});

describe("migrate", () => {
  const steps: Migration[] = [
    { version: 1, sql: "CREATE TABLE a (x)" },
    { version: 2, sql: "CREATE TABLE b (x)" },
  ];

  it("brings a new database to the latest version", () => {
    expect(migrate(db, steps)).toEqual({ from: 0, to: 2 });

    expect(userVersion()).toBe(2);
    expect(tables()).toEqual(["a", "b"]);
  });

  it("does nothing when the database is up to date", () => {
    migrate(db, steps);

    expect(migrate(db, steps)).toEqual({ from: 2, to: 2 });
    expect(tables()).toEqual(["a", "b"]);
  });

  it("only applies the migrations the database hasn't had", () => {
    migrate(db, steps.slice(0, 1));

    expect(migrate(db, steps)).toEqual({ from: 1, to: 2 });
    expect(tables()).toEqual(["a", "b"]);
  });

  it("rolls back a failing migration and keeps the earlier ones", () => {
    const failing = [
      ...steps,
      { version: 3, sql: "CREATE TABLE c (x); INSERT INTO missing VALUES (1)" },
    ];

    expect(() => migrate(db, failing)).toThrow("no such table: missing");
    expect(userVersion()).toBe(2);
    expect(tables()).toEqual(["a", "b"]);
  });

  it("refuses a database newer than the app", () => {
    db.exec("PRAGMA user_version = 3");

    expect(() => migrate(db, steps)).toThrow(DatabaseTooNewError);
  });

  describe("with foreign keys", () => {
    const parentAndChild: Migration = {
      version: 1,
      sql: `
        CREATE TABLE parent (id INTEGER PRIMARY KEY);
        CREATE TABLE child (parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE);
      `,
    };
    /** SQLite's documented way to change a table: create, copy, drop, rename. */
    const rebuildParent: Migration = {
      version: 2,
      sql: `
        CREATE TABLE new_parent (id INTEGER PRIMARY KEY, name TEXT);
        INSERT INTO new_parent (id) SELECT id FROM parent;
        DROP TABLE parent;
        ALTER TABLE new_parent RENAME TO parent;
      `,
    };

    beforeEach(() => {
      migrate(db, [parentAndChild]);
      db.exec("INSERT INTO parent VALUES (1); INSERT INTO child VALUES (1);");
    });

    it("keeps rows that reference a rebuilt table", () => {
      migrate(db, [parentAndChild, rebuildParent]);

      expect(db.selectValue("SELECT count(*) FROM child")).toBe(1);
    });

    it("leaves foreign keys on afterwards", () => {
      migrate(db, [parentAndChild, rebuildParent]);

      expect(db.selectValue("PRAGMA foreign_keys")).toBe(1);
    });

    it("rolls back a migration that leaves a dangling reference", () => {
      const dangling: Migration = { version: 2, sql: "DELETE FROM parent" };

      expect(() => migrate(db, [parentAndChild, dangling])).toThrow("foreign key");
      expect(userVersion()).toBe(1);
      expect(db.selectValue("SELECT count(*) FROM parent")).toBe(1);
    });
  });
});

describe("schema", () => {
  beforeEach(() => {
    migrate(db, MIGRATIONS);
    db.exec(`
      INSERT INTO accounts VALUES ('checking', 'SGD'), ('savings', 'SGD');
      INSERT INTO sources (hash, remarks) VALUES ('h1', 'statement.csv');
    `);
  });

  /** Inserts a transaction, overriding columns of a valid one. */
  function insertTransaction(overrides: Record<string, unknown> = {}) {
    const row: Record<string, unknown> = {
      seq: 1,
      id: "t1",
      source: "h1",
      account_name: "checking",
      amount: -12_500,
      currency: "SGD",
      counterparty: "Coffee",
      naive_date: "2026-10-10",
      ...overrides,
    };
    const columns = Object.keys(row);
    db.exec({
      sql: `INSERT INTO transactions (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      bind: Object.values(row) as never,
    });
  }

  it("creates the tables", () => {
    expect(tables()).toEqual(["accounts", "categories", "sources", "transactions"]);
  });

  it("accepts a valid transaction", () => {
    insertTransaction();

    expect(db.selectValue("SELECT count(*) FROM transactions")).toBe(1);
  });

  it("sets the import timestamp of a source", () => {
    expect(db.selectValue("SELECT import_timestamp FROM sources")).toBeGreaterThan(0);
  });

  it.each(["2026-02-30", "2026-1-5", "10/10/2026", "2026-10-10 12:00"])(
    "rejects the naive date %s",
    (naiveDate) => {
      expect(() => insertTransaction({ naive_date: naiveDate })).toThrow("CHECK constraint");
    },
  );

  it("rejects a category that is its own parent", () => {
    expect(() => db.exec("INSERT INTO categories VALUES ('food', 'food')")).toThrow(
      "no_self_parent",
    );
  });

  it("rejects a transfer to the same account", () => {
    expect(() => insertTransaction({ transfer_account: "checking" })).toThrow("no_self_transfer");
  });

  it("rejects a transaction that duplicates itself", () => {
    expect(() => insertTransaction({ duplicate_of: "t1" })).toThrow("no_self_duplicate");
  });

  it.each([{ converted_amount: 100 }, { converted_currency: "USD" }])(
    "rejects half a conversion: %o",
    (conversion) => {
      expect(() => insertTransaction(conversion)).toThrow("valid_conversion");
    },
  );

  it("enforces foreign keys", () => {
    expect(() => insertTransaction({ account_name: "missing" })).toThrow(
      "FOREIGN KEY constraint failed",
    );
  });

  it("cascades a renamed account to its transactions", () => {
    insertTransaction({ transfer_account: "savings" });

    db.exec("UPDATE accounts SET name = 'savings2' WHERE name = 'savings'");

    expect(db.selectValue("SELECT transfer_account FROM transactions")).toBe("savings2");
  });
});
