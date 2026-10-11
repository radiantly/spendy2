import sqlite3InitModule, { type Database } from "@sqlite.org/sqlite-wasm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureConnection } from "./connection.ts";
import { DatabaseTooNewError, migrate, migrationsFromFiles, type Migration } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.ts";

const sqlite3 = await sqlite3InitModule();

let db: Database;
beforeEach(() => {
  db = new sqlite3.oo1.DB(":memory:");
  configureConnection(db);
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

  describe("names ignore case", () => {
    it("rejects a category that differs from another only in case", () => {
      db.exec("INSERT INTO categories VALUES ('Groceries', NULL)");

      expect(() => db.exec("INSERT INTO categories VALUES ('groceries', NULL)")).toThrow(
        "UNIQUE constraint failed",
      );
    });

    it("rejects an account that differs from another only in case", () => {
      expect(() => db.exec("INSERT INTO accounts VALUES ('CHECKING', 'SGD')")).toThrow(
        "UNIQUE constraint failed",
      );
    });

    it("lets a transaction refer to a category in another case", () => {
      db.exec("INSERT INTO categories VALUES ('Groceries', NULL)");

      insertTransaction({ category: "GROCERIES", account_name: "Checking" });

      expect(db.selectValue("SELECT count(*) FROM transactions")).toBe(1);
    });

    it("rejects a category that is its own parent in another case", () => {
      expect(() => db.exec("INSERT INTO categories VALUES ('Food', 'food')")).toThrow(
        "no_self_parent",
      );
    });

    it("keeps a category still used by a transaction spelling it in another case", () => {
      db.exec("INSERT INTO categories VALUES ('Groceries', NULL)");
      insertTransaction({ category: "Groceries" });
      insertTransaction({ seq: 2, id: "t2", category: "groceries" });

      db.exec("UPDATE transactions SET category = NULL WHERE id = 't1'");

      expect(db.selectValue("SELECT category FROM transactions WHERE id = 't2'")).toBe("groceries");
      expect(db.selectValues("SELECT name FROM categories")).toEqual(["Groceries"]);
    });

    it("rejects a loop spelled in another case", () => {
      db.exec("INSERT INTO categories VALUES ('Housing', NULL), ('Utilities', 'Housing')");

      expect(() =>
        db.exec("UPDATE categories SET parent = 'UTILITIES' WHERE name = 'Housing'"),
      ).toThrow("A category can't be inside its own subcategory");
    });
  });

  describe("category loops", () => {
    const LOOP = "A category can't be inside its own subcategory";

    beforeEach(() => {
      db.exec(`
        INSERT INTO categories (name, parent) VALUES
          ('Housing', NULL), ('Utilities', 'Housing'), ('Power', 'Utilities'),
          ('Groceries', NULL);
      `);
    });

    const parentOf = (name: string) =>
      db.selectValue("SELECT parent FROM categories WHERE name = ?", [name]);

    it("rejects a loop of two", () => {
      expect(() =>
        db.exec("UPDATE categories SET parent = 'Utilities' WHERE name = 'Housing'"),
      ).toThrow(LOOP);
      expect(parentOf("Housing")).toBeNull();
    });

    it("rejects a loop of three", () => {
      expect(() =>
        db.exec("UPDATE categories SET parent = 'Power' WHERE name = 'Housing'"),
      ).toThrow(LOOP);
    });

    it("rejects a loop made while foreign keys are off, e.g. during a migration", () => {
      db.exec("PRAGMA foreign_keys = OFF");

      expect(() =>
        db.exec("INSERT INTO categories VALUES ('Bills', 'Fees'), ('Fees', 'Bills')"),
      ).toThrow(LOOP);
    });

    it("allows moving a category elsewhere in the tree", () => {
      db.exec("UPDATE categories SET parent = 'Housing' WHERE name = 'Power'");

      expect(parentOf("Power")).toBe("Housing");
    });

    it("allows moving a subtree under an unrelated category", () => {
      db.exec("UPDATE categories SET parent = 'Groceries' WHERE name = 'Housing'");

      expect(parentOf("Housing")).toBe("Groceries");
    });

    it("allows renaming a category with a parent and subcategories", () => {
      db.exec("UPDATE categories SET name = 'Bills' WHERE name = 'Utilities'");

      expect(parentOf("Bills")).toBe("Housing");
      expect(parentOf("Power")).toBe("Bills");
    });
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

  describe("unused categories", () => {
    beforeEach(() => {
      db.exec(`
        INSERT INTO categories (name, parent) VALUES
          ('Housing', NULL), ('Utilities', 'Housing'), ('Power', 'Utilities'),
          ('Groceries', NULL), ('Dining out', NULL);
      `);
    });

    const categories = () => db.selectValues("SELECT name FROM categories ORDER BY name");

    it("deletes a category when its last transaction moves off it", () => {
      insertTransaction({ category: "Groceries" });

      db.exec("UPDATE transactions SET category = 'Dining out'");

      expect(categories()).not.toContain("Groceries");
    });

    it("deletes a category when its last transaction's category is cleared", () => {
      insertTransaction({ category: "Groceries" });

      db.exec("UPDATE transactions SET category = NULL");

      expect(categories()).not.toContain("Groceries");
    });

    it("keeps a category another transaction still uses", () => {
      insertTransaction({ category: "Groceries" });
      insertTransaction({ seq: 2, id: "t2", category: "Groceries" });

      db.exec("UPDATE transactions SET category = 'Dining out' WHERE id = 't1'");

      expect(categories()).toContain("Groceries");
    });

    it("deletes a category when its last transaction is deleted", () => {
      insertTransaction({ category: "Groceries" });

      db.exec("DELETE FROM transactions");

      expect(categories()).not.toContain("Groceries");
    });

    it("deletes a category whose last transaction goes with its source", () => {
      insertTransaction({ category: "Groceries" });

      db.exec("DELETE FROM sources");

      expect(categories()).not.toContain("Groceries");
    });

    it("leaves other unused categories alone", () => {
      insertTransaction({ category: "Groceries" });

      db.exec("UPDATE transactions SET category = NULL");

      expect(categories()).toContain("Dining out");
    });

    it("keeps a category that has subcategories", () => {
      insertTransaction({ category: "Utilities" });
      insertTransaction({ seq: 2, id: "t2", category: "Power" });

      db.exec("UPDATE transactions SET category = NULL WHERE id = 't1'");

      expect(categories()).toContain("Utilities");
    });

    it("deletes an unused parent with its last subcategory", () => {
      insertTransaction({ category: "Utilities" });
      db.exec("DELETE FROM categories WHERE name = 'Power'");

      db.exec("UPDATE transactions SET category = NULL");

      expect(categories()).not.toContain("Utilities");
      expect(categories()).not.toContain("Housing");
    });

    it("keeps a parent that has transactions of its own", () => {
      insertTransaction({ category: "Utilities" });
      db.exec("DELETE FROM categories WHERE name = 'Power'");
      insertTransaction({ seq: 2, id: "t2", category: "Housing" });

      db.exec("UPDATE transactions SET category = NULL WHERE id = 't1'");

      expect(categories()).not.toContain("Utilities");
      expect(categories()).toContain("Housing");
    });

    it("deletes unused ancestors at any depth", () => {
      insertTransaction({ category: "Power" });

      db.exec("UPDATE transactions SET category = NULL");

      expect(categories()).toEqual(["Dining out", "Groceries"]);
    });

    it("deletes a parent left unused when its subcategory moves elsewhere", () => {
      insertTransaction({ category: "Utilities" });
      db.exec("DELETE FROM categories WHERE name = 'Power'");

      db.exec("UPDATE categories SET parent = 'Groceries' WHERE name = 'Utilities'");

      expect(categories()).not.toContain("Housing");
    });

    it("deletes an unused category's unused parent when it's deleted", () => {
      db.exec("DELETE FROM categories WHERE name = 'Power'");

      expect(categories()).not.toContain("Utilities");
    });

    it("keeps a renamed category's transactions on it", () => {
      insertTransaction({ category: "Groceries" });

      db.exec("UPDATE categories SET name = 'Food' WHERE name = 'Groceries'");

      expect(categories()).toContain("Food");
      expect(db.selectValue("SELECT category FROM transactions")).toBe("Food");
    });
  });
});
