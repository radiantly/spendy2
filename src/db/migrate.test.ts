import sqlite3InitModule, { type Database } from "@sqlite.org/sqlite-wasm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureConnection } from "./connection.ts";
import { DatabaseTooNewError, migrate, migrationsFromFiles, type Migration } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.ts";
import { SOURCE_HASH, SOURCE_HASH_SQL, transactionId } from "../test/fixtures.ts";

const sqlite3 = await sqlite3InitModule();
const [T1, T2, T9] = [1, 2, 9].map(transactionId);

let db: Database;
beforeEach(() => {
  db = new sqlite3.oo1.DB(":memory:");
  configureConnection(db);
});
afterEach(() => db.close());

const userVersion = () => db.selectValue("PRAGMA user_version");
const tables = () =>
  db.selectValues("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
/**
 * A comment, a string or a double-quoted name. Matched from the left, so a
 * quote inside one of them doesn't start another.
 */
const SQL_TOKEN = /--.*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"/g;
/** The double-quoted names in the stored statements. */
const quotedNames = () =>
  db
    .selectValues("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL")
    .flatMap((sql) => [...String(sql).matchAll(SQL_TOKEN)].map(([token]) => token))
    .filter((token) => token.startsWith('"'));

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
        CREATE VIEW parent_ids AS SELECT id FROM parent;
        CREATE TRIGGER delete_parent_with_child AFTER DELETE ON child
        BEGIN
          DELETE FROM parent WHERE id = OLD.parent_id;
        END;
      `,
    };
    /** Changes a table the way migrate() describes, without renaming it. */
    const rebuildParent: Migration = {
      version: 2,
      sql: `
        CREATE TABLE parent_copy (id INTEGER PRIMARY KEY, name TEXT);
        INSERT INTO parent_copy (id) SELECT id FROM parent;
        DROP TABLE parent;
        CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT);
        INSERT INTO parent SELECT * FROM parent_copy;
        DROP TABLE parent_copy;
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

    it("keeps the views and triggers that refer to a rebuilt table working", () => {
      migrate(db, [parentAndChild, rebuildParent]);

      expect(db.selectValues("SELECT id FROM parent_ids")).toEqual([1]);
      db.exec("DELETE FROM child");
      expect(db.selectValue("SELECT count(*) FROM parent")).toBe(0);
    });

    it("stores a rebuilt table's statement as written", () => {
      migrate(db, [parentAndChild, rebuildParent]);

      expect(db.selectValue("SELECT sql FROM sqlite_schema WHERE name = 'parent'")).toBe(
        "CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT)",
      );
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
      INSERT INTO accounts VALUES ('checking', 'SGD', 'Bank', NULL), ('savings', 'SGD', 'Bank', NULL);
      INSERT INTO sources (hash, remarks) VALUES (${SOURCE_HASH_SQL}, 'statement.csv');
    `);
  });

  /** Inserts a transaction, overriding columns of a valid one. */
  function insertTransaction(overrides: Record<string, unknown> = {}) {
    const row: Record<string, unknown> = {
      seq: 1,
      id: T1,
      source: SOURCE_HASH,
      account_name: "checking",
      amount: -125,
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
    expect(tables()).toEqual([
      "accounts",
      "categories",
      "conversions",
      "currencies",
      "sources",
      "transactions",
    ]);
  });

  // renaming a table quotes its name everywhere; migrate() describes a rebuild without one
  it("quotes no names, so no migration renamed a table", () => {
    expect(quotedNames()).toEqual([]);
  });

  it("would see a renamed table's name, but not quotes in comments or strings", () => {
    db.exec(`
      CREATE TABLE renamed (
        -- the "x" column, it's checked
        x TEXT CHECK (x <> '"')
      );
      CREATE INDEX renamed_x ON renamed(x);
      ALTER TABLE renamed RENAME TO later;
    `);

    expect(quotedNames()).toEqual(['"later"', '"later"']);
  });

  it("accepts a valid transaction", () => {
    insertTransaction();

    expect(db.selectValue("SELECT count(*) FROM transactions")).toBe(1);
  });

  it("rejects a value of the wrong type", () => {
    expect(() => insertTransaction({ amount: "-1.25" })).toThrow("SQLITE_CONSTRAINT_DATATYPE");
  });

  it("has ISO 4217's currencies, with their decimals", () => {
    const decimals = (code: string) =>
      db.selectValue("SELECT stored_decimals FROM currencies WHERE code = ?", [code]);

    expect([decimals("USD"), decimals("JPY"), decimals("BHD"), decimals("HUF")]).toEqual([
      2, 0, 3, 2,
    ]);
  });

  it.each([
    ["a currency's code", "INSERT INTO currencies VALUES ('', 2)"],
    ["a currency's stored decimals", "INSERT INTO currencies VALUES ('XBT', -1)"],
  ])("rejects an invalid value for %s", (_, sql) => {
    expect(() => db.exec(sql)).toThrow("CHECK constraint");
  });

  it("allows a currency of the user's own", () => {
    db.exec("INSERT INTO currencies VALUES ('XBT', 8)");
    insertTransaction({ currency: "XBT", amount: 1 });

    expect(db.selectValue("SELECT count(*) FROM transactions")).toBe(1);
  });

  it.each([
    ["a transaction's", () => insertTransaction({ currency: "ABC" })],
    [
      "an account's display",
      () => db.exec("INSERT INTO accounts VALUES ('cash', 'ABC', 'Cash', NULL)"),
    ],
    [
      "a conversion's",
      () => {
        insertTransaction();
        db.exec(`INSERT INTO conversions VALUES ('${T1}', 'ABC', 1)`);
      },
    ],
  ])("rejects %s currency when it isn't one of the currencies", (_, insert) => {
    expect(insert).toThrow("FOREIGN KEY constraint failed");
  });

  it("keeps a currency that's in use", () => {
    expect(() => db.exec("DELETE FROM currencies WHERE code = 'SGD'")).toThrow(
      "FOREIGN KEY constraint failed",
    );
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

  it.each([
    "00000000-0000-4000-8000-00000000000A",
    "00000000-0000-1000-8000-000000000001",
    "00000000-0000-4000-c000-000000000001",
    "00000000000040008000000000000001",
    "t1",
  ])("rejects the transaction id %s, which isn't a lowercase UUIDv4", (id) => {
    expect(() => insertTransaction({ id })).toThrow("CHECK constraint");
  });

  it.each(["counterparty", "remarks"])("rejects an empty %s", (column) => {
    expect(() => insertTransaction({ [column]: "" })).toThrow("CHECK constraint");
  });

  it.each([
    ["an account's name", "INSERT INTO accounts VALUES ('', 'SGD', 'Bank', NULL)"],
    ["an account's type", "INSERT INTO accounts VALUES ('cash', 'SGD', '', NULL)"],
    ["an account's identifier", "INSERT INTO accounts VALUES ('cash', 'SGD', 'Bank', '')"],
    ["a category's name", "INSERT INTO categories VALUES ('', NULL)"],
    ["a source's remarks", `INSERT INTO sources VALUES (X'${"01".repeat(32)}', '', 0)`],
  ])("rejects an empty value for %s", (_, sql) => {
    expect(() => db.exec(sql)).toThrow("CHECK constraint");
  });

  it("rejects an account without a type", () => {
    expect(() => db.exec("INSERT INTO accounts VALUES ('cash', 'SGD', NULL, NULL)")).toThrow(
      "NOT NULL constraint",
    );
  });

  it("allows an account without an identifier", () => {
    db.exec("INSERT INTO accounts VALUES ('cash', 'SGD', 'Cash', NULL)");

    expect(db.selectValue("SELECT identifier FROM accounts WHERE name = 'cash'")).toBeNull();
  });

  it("allows an account without a display currency", () => {
    db.exec("INSERT INTO accounts VALUES ('cash', NULL, 'Bank', NULL)");

    expect(db.selectValue("SELECT display_currency FROM accounts WHERE name = 'cash'")).toBeNull();
  });

  it.each([31, 33])("rejects a source hash of %i bytes", (length) => {
    expect(() =>
      db.exec(
        `INSERT INTO sources (hash, remarks) VALUES (X'${"01".repeat(length)}', 'other.csv')`,
      ),
    ).toThrow("CHECK constraint");
  });

  it("rejects a source hash given as text", () => {
    expect(() =>
      db.exec(`INSERT INTO sources (hash, remarks) VALUES ('${"01".repeat(32)}', 'other.csv')`),
    ).toThrow("SQLITE_CONSTRAINT_DATATYPE");
  });

  it("rejects a transaction's source given as text", () => {
    expect(() => insertTransaction({ source: "00".repeat(32) })).toThrow(
      "SQLITE_CONSTRAINT_DATATYPE",
    );
  });

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
      expect(() =>
        db.exec("INSERT INTO accounts VALUES ('CHECKING', 'SGD', 'Bank', NULL)"),
      ).toThrow("UNIQUE constraint failed");
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
      insertTransaction({ seq: 2, id: T2, category: "groceries" });

      db.exec(`UPDATE transactions SET category = NULL WHERE id = '${T1}'`);

      expect(db.selectValue(`SELECT category FROM transactions WHERE id = '${T2}'`)).toBe(
        "groceries",
      );
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
    expect(() => insertTransaction({ duplicate_of: T1 })).toThrow("no_self_duplicate");
  });

  describe("conversions", () => {
    const OWN_CURRENCY = "A transaction can't be converted to its own currency";

    function insertConversion(currency: string, transactionId = T1) {
      db.exec({
        sql: "INSERT INTO conversions VALUES (?, ?, -90)",
        bind: [transactionId, currency],
      });
    }

    const conversions = () =>
      db.selectArrays("SELECT transaction_id, currency FROM conversions ORDER BY currency");

    beforeEach(() => insertTransaction());

    it("allows conversions to several currencies", () => {
      insertConversion("USD");
      insertConversion("EUR");

      expect(conversions()).toEqual([
        [T1, "EUR"],
        [T1, "USD"],
      ]);
    });

    it("rejects a second conversion to the same currency", () => {
      insertConversion("USD");

      expect(() => insertConversion("USD")).toThrow("UNIQUE constraint failed");
    });

    it("rejects a conversion of a missing transaction", () => {
      expect(() => insertConversion("USD", "missing")).toThrow("FOREIGN KEY constraint failed");
    });

    it("rejects a conversion to the transaction's own currency", () => {
      expect(() => insertConversion("SGD")).toThrow(OWN_CURRENCY);
    });

    it("rejects changing a conversion to the transaction's own currency", () => {
      insertConversion("USD");

      expect(() => db.exec("UPDATE conversions SET currency = 'SGD'")).toThrow(OWN_CURRENCY);
    });

    it("rejects moving a conversion to a transaction in its currency", () => {
      insertTransaction({ seq: 2, id: T2, currency: "USD" });
      insertConversion("USD");

      expect(() => db.exec(`UPDATE conversions SET transaction_id = '${T2}'`)).toThrow(
        OWN_CURRENCY,
      );
    });

    it("rejects changing a transaction's currency to one it has a conversion to", () => {
      insertConversion("USD");

      expect(() => db.exec("UPDATE transactions SET currency = 'USD'")).toThrow(OWN_CURRENCY);
    });

    it("deletes a transaction's conversions with it", () => {
      insertConversion("USD");

      db.exec("DELETE FROM transactions");

      expect(conversions()).toEqual([]);
    });

    it("keeps a transaction's conversions when its id changes", () => {
      insertConversion("USD");

      db.exec(`UPDATE transactions SET id = '${T9}'`);

      expect(conversions()).toEqual([[T9, "USD"]]);
    });
  });

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
      insertTransaction({ seq: 2, id: T2, category: "Groceries" });

      db.exec(`UPDATE transactions SET category = 'Dining out' WHERE id = '${T1}'`);

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
      insertTransaction({ seq: 2, id: T2, category: "Power" });

      db.exec(`UPDATE transactions SET category = NULL WHERE id = '${T1}'`);

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
      insertTransaction({ seq: 2, id: T2, category: "Housing" });

      db.exec(`UPDATE transactions SET category = NULL WHERE id = '${T1}'`);

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
