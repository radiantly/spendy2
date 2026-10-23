import sqlite3InitModule, { type Database } from "@sqlite.org/sqlite-wasm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tableStatements } from "./schema.ts";

const sqlite3 = await sqlite3InitModule();

let db: Database;
beforeEach(() => {
  db = new sqlite3.oo1.DB(":memory:");
});
afterEach(() => db.close());

describe("tableStatements", () => {
  it("lists the tables' statements in the order they were created", () => {
    db.exec("CREATE TABLE b (x); CREATE TABLE a (y)");

    expect(tableStatements(db)).toEqual(["CREATE TABLE b (x)", "CREATE TABLE a (y)"]);
  });

  it("keeps the comments inside a statement, but not the ones before it", () => {
    db.exec("-- before\nCREATE TABLE a (\n  x -- inside\n)");

    expect(tableStatements(db)).toEqual(["CREATE TABLE a (\n  x -- inside\n)"]);
  });

  it("leaves out indexes, views and triggers", () => {
    db.exec(`
      CREATE TABLE a (x);
      CREATE INDEX a_x ON a(x);
      CREATE VIEW v AS SELECT x FROM a;
      CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; END;
    `);

    expect(tableStatements(db)).toEqual(["CREATE TABLE a (x)"]);
  });

  it("leaves out SQLite's own tables", () => {
    // AUTOINCREMENT creates sqlite_sequence, ANALYZE creates sqlite_stat1
    db.exec(`
      CREATE TABLE a (id INTEGER PRIMARY KEY AUTOINCREMENT);
      INSERT INTO a DEFAULT VALUES;
      ANALYZE;
    `);

    expect(tableStatements(db)).toEqual(["CREATE TABLE a (id INTEGER PRIMARY KEY AUTOINCREMENT)"]);
  });

  it("shows a column added by a migration", () => {
    db.exec("CREATE TABLE a (x); ALTER TABLE a ADD COLUMN y TEXT");

    expect(tableStatements(db)).toEqual(["CREATE TABLE a (x, y TEXT)"]);
  });
});
