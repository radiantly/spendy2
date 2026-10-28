import sqlite3InitModule, { type Database } from "@sqlite.org/sqlite-wasm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyChanges, invert, Session } from "./changes.ts";
import { configureConnection } from "./connection.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS } from "./migrations.ts";
import { SOURCE_HASH_SQL, transactionId } from "../test/fixtures.ts";

const sqlite3 = await sqlite3InitModule();
const [T1, T2, T9] = [1, 2, 9].map(transactionId);

let db: Database;
beforeEach(() => {
  db = new sqlite3.oo1.DB(":memory:");
  configureConnection(db);
  migrate(db, MIGRATIONS);
  db.exec(`
    INSERT INTO accounts VALUES ('Checking', 'USD', 'Bank', NULL), ('Savings', 'USD', 'Bank', NULL);
    INSERT INTO sources (hash, remarks) VALUES (${SOURCE_HASH_SQL}, 'statement.csv');
    INSERT INTO categories VALUES ('Food', NULL), ('Groceries', 'Food'), ('Bills', NULL);
    INSERT INTO transactions (sort_key, id, source, account_name, amount, currency, counterparty, category, naive_date, remarks)
    VALUES (1, '${T1}', ${SOURCE_HASH_SQL}, 'Checking', -100, 'USD', 'Corner Market', 'Groceries', '2026-10-01', 'weekly'),
           (2, '${T2}', ${SOURCE_HASH_SQL}, 'Checking', -200, 'USD', 'City Power', 'Bills', '2026-10-02', NULL);
    INSERT INTO conversions VALUES ('${T1}', 'EUR', -90);
  `);
});
afterEach(() => db.close());

/** Every table's rows, to compare whole states. */
const state = () =>
  ["accounts", "sources", "categories", "transactions", "conversions"].map((table) =>
    db.selectArrays(`SELECT * FROM ${table} ORDER BY 1, 2`),
  );

/** Runs `sql` in a transaction, returning the changes it made. */
function record(sql: string) {
  const session = new Session(sqlite3, db);
  try {
    db.transaction(() => db.exec(sql));
    return session.changes();
  } finally {
    session.end();
  }
}

const undo = (changes: Uint8Array) => applyChanges(sqlite3, db, invert(sqlite3, db, changes));
const redo = (changes: Uint8Array) => applyChanges(sqlite3, db, changes);

describe("undo and redo", () => {
  it.each([
    ["an edit", `UPDATE transactions SET counterparty = 'Corner Shop' WHERE id = '${T1}'`],
    ["an amount", `UPDATE transactions SET amount = -250 WHERE id = '${T1}'`],
    // The triggers delete Groceries, then Food.
    ["clearing a category", `UPDATE transactions SET category = NULL WHERE id = '${T1}'`],
    [
      "moving to a new category",
      `INSERT INTO categories (name) VALUES ('Coffee') ON CONFLICT DO NOTHING;
       UPDATE transactions SET category = 'Coffee' WHERE id = '${T1}'`,
    ],
    ["clearing a range", "UPDATE transactions SET category = NULL, remarks = NULL"],
    // Cascades to the transaction.
    ["renaming a category", "UPDATE categories SET name = 'Shopping' WHERE name = 'Groceries'"],
    // Cascades to the conversion.
    ["changing a transaction's id", `UPDATE transactions SET id = '${T9}' WHERE id = '${T1}'`],
    // Cascades to every transaction, their conversions, and the categories left unused.
    ["deleting an account", "DELETE FROM accounts WHERE name = 'Checking'"],
  ])("restores exactly what %s changed, again and again", (_, sql) => {
    const before = state();
    const changes = record(sql);
    const after = state();

    for (let i = 0; i < 2; i++) {
      undo(changes);
      expect(state()).toEqual(before);
      redo(changes);
      expect(state()).toEqual(after);
    }
    expect(db.selectArrays("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("puts a category deleted for being unused back under its parent", () => {
    const changes = record(`UPDATE transactions SET category = NULL WHERE id = '${T1}'`);
    expect(db.selectValues("SELECT name FROM categories ORDER BY name")).toEqual(["Bills"]);

    undo(changes);

    expect(db.selectArrays("SELECT name, parent FROM categories ORDER BY name")).toEqual([
      ["Bills", null],
      ["Food", null],
      ["Groceries", "Food"],
    ]);
  });

  it("leaves triggers on afterwards", () => {
    undo(record(`UPDATE transactions SET category = NULL WHERE id = '${T1}'`));

    db.exec(`UPDATE transactions SET category = NULL WHERE id = '${T2}'`);

    expect(db.selectValues("SELECT name FROM categories")).not.toContain("Bills");
  });

  it("refuses changes that don't match the database, changing nothing", () => {
    const changes = record(
      `UPDATE transactions SET counterparty = 'Corner Shop' WHERE id = '${T1}'`,
    );
    undo(changes);
    const before = state();

    expect(() => undo(changes)).toThrow("The changes don't match the database");
    expect(state()).toEqual(before);
  });

  it("records nothing for a change that doesn't change anything", () => {
    expect(record("UPDATE transactions SET counterparty = counterparty")).toHaveLength(0);
  });
});

describe("Session.hasChanges", () => {
  let session: Session;
  beforeEach(() => (session = new Session(sqlite3, db)));
  afterEach(() => session.end());

  it("has none at first", () => {
    expect(session.hasChanges()).toBe(false);
  });

  it("has a change", () => {
    db.exec(`UPDATE transactions SET counterparty = 'Corner Shop' WHERE id = '${T1}'`);

    expect(session.hasChanges()).toBe(true);
  });

  it("has none once a change is changed back", () => {
    db.exec(`UPDATE transactions SET counterparty = 'Corner Shop' WHERE id = '${T1}'`);
    db.exec(`UPDATE transactions SET counterparty = 'Corner Market' WHERE id = '${T1}'`);

    expect(session.hasChanges()).toBe(false);
  });

  it("has none once a change with side effects is undone", () => {
    undo(record(`UPDATE transactions SET category = NULL WHERE id = '${T1}'`));

    expect(session.hasChanges()).toBe(false);
  });

  it("has some when a category is set back by hand but lost its parent", () => {
    db.exec(`UPDATE transactions SET category = NULL WHERE id = '${T1}'`);
    db.exec(`
      INSERT INTO categories (name) VALUES ('Groceries') ON CONFLICT DO NOTHING;
      UPDATE transactions SET category = 'Groceries' WHERE id = '${T1}';
    `);

    expect(session.hasChanges()).toBe(true);
  });

  it("has none after a transaction that was rolled back", () => {
    expect(() =>
      db.transaction(() => {
        db.exec(`UPDATE transactions SET counterparty = 'Corner Shop' WHERE id = '${T1}'`);
        db.exec("INSERT INTO categories VALUES ('Fees', 'Missing')");
      }),
    ).toThrow("FOREIGN KEY");

    expect(session.hasChanges()).toBe(false);
  });
});
