import sqlite3InitModule, { type BindingSpec, type Database } from "@sqlite.org/sqlite-wasm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureConnection } from "../connection.ts";
import { migrate } from "../migrate.ts";
import { MIGRATIONS } from "../migrations.ts";
import { SOURCE_HASH_SQL, transactionId } from "../../test/fixtures.ts";
import { DEFAULT_VIEW, sortOrder } from "../../pages/transactions/view.ts";
import { GET_TRANSACTIONS, LIST_TRANSACTIONS, listedTransactions } from "./transactions.ts";

const sqlite3 = await sqlite3InitModule();

let db: Database;
let count = 0;
beforeEach(() => {
  db = new sqlite3.oo1.DB(":memory:");
  configureConnection(db);
  migrate(db, MIGRATIONS);
  count = 0;
  db.exec(`
    INSERT INTO accounts VALUES ('Checking', 'USD', 'Bank', NULL), ('Travel', 'EUR', 'Card', NULL);
    INSERT INTO sources (hash, remarks) VALUES (${SOURCE_HASH_SQL}, 'statement.csv');
    INSERT INTO categories VALUES ('Groceries', NULL);
  `);
});
afterEach(() => db.close());

/**
 * Inserts EUR -9.20 on `date`, with `conversions` as stored (in each
 * currency's stored_decimals). Unless given, it has no time, and its sort key
 * follows the ones before it, as an import's do. Returns its id, which
 * follows the ones before it too.
 */
function add(
  date: string,
  {
    counterparty = "Somewhere",
    conversions = {},
    timestamp = null,
    sortKey,
  }: {
    counterparty?: string;
    conversions?: Record<string, number>;
    timestamp?: number | null;
    sortKey?: number;
  } = {},
) {
  count++;
  const id = transactionId(count);
  db.exec({
    sql: `INSERT INTO transactions (sort_key, timestamp, id, source, account_name, amount,
      currency, counterparty, category, naive_date)
      VALUES (?, ?, ?, ${SOURCE_HASH_SQL}, 'Travel', -920, 'EUR', ?, 'Groceries', ?)`,
    bind: [sortKey ?? count, timestamp, id, counterparty, date],
  });
  for (const [currency, amount] of Object.entries(conversions))
    db.exec({ sql: "INSERT INTO conversions VALUES (?, ?, ?)", bind: [id, currency, amount] });
  return id;
}

const listed = (sql: string, bind?: BindingSpec) => listedTransactions(db.selectObjects(sql, bind));
const ids = (sql: string, bind?: BindingSpec) => listed(sql, bind).map(({ id }) => id);
/** A time on 2026-10-05 (`HH:MM`, UTC), as a timestamp. */
const at = (time: string) => Date.parse(`2026-10-05T${time}Z`) / 1000;

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

  it("lists a day's transactions with a time first, latest first, then those without", () => {
    const evening = add("2026-10-05", { timestamp: at("18:00") });
    const morning = add("2026-10-05", { timestamp: at("09:00") });
    const untimed = add("2026-10-05");

    expect(ids(LIST_TRANSACTIONS)).toEqual([evening, morning, untimed]);
  });

  it("lists a transaction on its date, whatever day its time is on", () => {
    const later = add("2026-10-05", { timestamp: at("12:00") + 2 * 86_400 });
    const next = add("2026-10-06");

    expect(ids(LIST_TRANSACTIONS)).toEqual([next, later]);
  });

  it.each([
    ["the same time", at("12:00")],
    ["no time", null],
  ])("lists a day's transactions with %s by sort key, highest first", (_, timestamp) => {
    const higher = add("2026-10-05", { timestamp, sortKey: 2 });
    const lower = add("2026-10-05", { timestamp, sortKey: 1 });

    expect(ids(LIST_TRANSACTIONS)).toEqual([higher, lower]);
  });

  it("lists a day's transactions with the same sort key by id, the highest first", () => {
    const lower = add("2026-10-05", { sortKey: 1 });
    const higher = add("2026-10-05", { sortKey: 1 });

    expect(ids(LIST_TRANSACTIONS)).toEqual([higher, lower]);
  });

  it("lists them in the order the transactions page sorts them by date", () => {
    add("2026-10-05", { timestamp: at("09:00"), sortKey: 3 });
    add("2026-10-05", { sortKey: 1 });
    add("2026-10-05", { timestamp: at("09:00"), sortKey: 1 });
    add("2026-10-01", { timestamp: at("23:00") });
    add("2026-10-05", { sortKey: 1 });
    add("2026-10-05", { timestamp: at("18:00"), sortKey: 0 });
    const rows = listed(LIST_TRANSACTIONS);
    // Reversed, so the page's sort has to put each in its place.
    const reversed = rows.toReversed();

    const sorted = sortOrder(
      reversed,
      DEFAULT_VIEW.sort,
      { accounts: ["Travel"], categories: ["Groceries"] },
      new Map(),
    ).map((position) => reversed[position]!.id);

    expect(sorted).toEqual(rows.map(({ id }) => id));
  });

  it("gives every column of a transaction", () => {
    const id = add("2026-10-05", { counterparty: "Café Sol" });

    expect(listed(LIST_TRANSACTIONS)).toEqual([
      {
        id,
        naive_date: "2026-10-05",
        timestamp: null,
        sort_key: 1,
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
