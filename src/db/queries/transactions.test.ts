import sqlite3InitModule, { type BindingSpec, type Database } from "@sqlite.org/sqlite-wasm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureConnection } from "../connection.ts";
import { migrate } from "../migrate.ts";
import { MIGRATIONS } from "../migrations.ts";
import { SOURCE_HASH_SQL, transactionId } from "../../test/fixtures.ts";
import { GET_TRANSACTIONS, LIST_TRANSACTIONS, listedTransactions } from "./transactions.ts";

const sqlite3 = await sqlite3InitModule();

let db: Database;
let seq = 0;
beforeEach(() => {
  db = new sqlite3.oo1.DB(":memory:");
  configureConnection(db);
  migrate(db, MIGRATIONS);
  seq = 0;
  db.exec(`
    INSERT INTO accounts VALUES ('Checking', 'USD', 'Bank', NULL), ('Travel', 'EUR', 'Card', NULL);
    INSERT INTO sources (hash, remarks) VALUES (${SOURCE_HASH_SQL}, 'statement.csv');
    INSERT INTO categories VALUES ('Groceries', NULL);
  `);
});
afterEach(() => db.close());

/**
 * Inserts EUR -9.20 on `date`, with `conversions` as stored (in each
 * currency's stored_decimals). Returns its id.
 */
function add(
  date: string,
  {
    counterparty = "Somewhere",
    conversions = {},
  }: { counterparty?: string; conversions?: Record<string, number> } = {},
) {
  seq++;
  const id = transactionId(seq);
  db.exec({
    sql: `INSERT INTO transactions (seq, id, source, account_name, amount, currency, counterparty,
      category, naive_date)
      VALUES (?, ?, ${SOURCE_HASH_SQL}, 'Travel', -920, 'EUR', ?, 'Groceries', ?)`,
    bind: [seq, id, counterparty, date],
  });
  for (const [currency, amount] of Object.entries(conversions))
    db.exec({ sql: "INSERT INTO conversions VALUES (?, ?, ?)", bind: [id, currency, amount] });
  return id;
}

const listed = (sql: string, bind?: BindingSpec) => listedTransactions(db.selectObjects(sql, bind));
const ids = (sql: string, bind?: BindingSpec) => listed(sql, bind).map(({ id }) => id);

describe("LIST_TRANSACTIONS", () => {
  it("is empty without transactions", () => {
    expect(listed(LIST_TRANSACTIONS)).toEqual([]);
  });

  it("lists every transaction newest first, and a day's latest import first", () => {
    const older = add("2026-10-01");
    const first = add("2026-10-05");
    const second = add("2026-10-05");

    expect(ids(LIST_TRANSACTIONS)).toEqual([second, first, older]);
  });

  it("gives every column of a transaction", () => {
    const id = add("2026-10-05", { counterparty: "Café Sol" });

    expect(listed(LIST_TRANSACTIONS)).toEqual([
      {
        id,
        naive_date: "2026-10-05",
        account_name: "Travel",
        counterparty: "Café Sol",
        category: "Groceries",
        amount: -920,
        decimals: 2,
        currency: "EUR",
        remarks: null,
        transfer_account: null,
        duplicate_of: null,
        conversions: {},
      },
    ]);
  });

  it("gives a transaction's conversions as an object of amounts", () => {
    add("2026-10-05", { conversions: { USD: -1012, JPY: -1500 } });

    expect(listed(LIST_TRANSACTIONS)[0]!.conversions).toEqual({
      USD: { amount: -1012, decimals: 2 },
      JPY: { amount: -1500, decimals: 0 },
    });
  });

  it("gives each amount with its currency's stored decimals", () => {
    db.exec("UPDATE currencies SET stored_decimals = 4 WHERE code = 'EUR'");
    add("2026-10-05");

    expect(listed(LIST_TRANSACTIONS)[0]).toMatchObject({ amount: -920, decimals: 4 });
  });

  it("keeps text as it is, quotes and all", () => {
    const text = `"Joe's" \\ Ünïcödé 🍕 {"not": "json"}`;
    add("2026-10-05", { counterparty: text });

    expect(listed(LIST_TRANSACTIONS)[0]!.counterparty).toBe(text);
  });
});

describe("GET_TRANSACTIONS", () => {
  it("gives the transactions with the ids asked for, ignoring unknown ones", () => {
    const a = add("2026-10-01", { conversions: { USD: -1012 } });
    add("2026-10-02");
    const c = add("2026-10-03");

    const got = listed(GET_TRANSACTIONS, [JSON.stringify([a, c, transactionId(99)])]);

    expect(got.map(({ id }) => id).sort()).toEqual([a, c].sort());
    expect(got.find(({ id }) => id === a)!.conversions).toEqual({
      USD: { amount: -1012, decimals: 2 },
    });
  });

  it("is empty when no id matches", () => {
    add("2026-10-01");

    expect(listed(GET_TRANSACTIONS, [JSON.stringify([transactionId(99)])])).toEqual([]);
  });
});
