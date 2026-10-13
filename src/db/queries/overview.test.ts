import sqlite3InitModule, { type BindingSpec, type Database } from "@sqlite.org/sqlite-wasm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureConnection } from "../connection.ts";
import { migrate } from "../migrate.ts";
import { MIGRATIONS } from "../migrations.ts";
import {
  GET_OVERVIEW_META,
  GET_PERIOD_SUMMARY,
  LIST_ACCOUNT_ACTIVITY,
  LIST_CATEGORY_PARENTS,
  LIST_CATEGORY_SPENDING,
  LIST_DAILY_SPENDING,
  LIST_MONTHLY_TOTALS,
  LIST_RECENT_TRANSACTIONS,
} from "./overview.ts";

const sqlite3 = await sqlite3InitModule();

let db: Database;
let seq = 0;
beforeEach(() => {
  db = new sqlite3.oo1.DB(":memory:");
  configureConnection(db);
  migrate(db, MIGRATIONS);
  seq = 0;
  db.exec(`
    INSERT INTO accounts VALUES ('Checking', 'USD'), ('Savings', 'USD'), ('Travel', 'EUR'), ('India', 'INR');
    INSERT INTO sources (hash, remarks) VALUES ('s', 'statement.csv');
    INSERT INTO categories VALUES ('Food', NULL), ('Groceries', 'Food'), ('Income', NULL), ('Salary', 'Income');
  `);
});
afterEach(() => db.close());

type Transaction = {
  id?: string;
  date?: string;
  account?: string;
  amount: number;
  currency?: string;
  converted?: [number, string];
  category?: string | null;
  transfer?: string;
  duplicateOf?: string;
  counterparty?: string;
};

/** Inserts a transaction; amounts are in whole units. Returns its id. */
function add({
  id = `t${seq + 1}`,
  date = "2026-10-05",
  account = "Checking",
  amount,
  currency = "USD",
  converted,
  category = null,
  transfer,
  duplicateOf,
  counterparty = "Somewhere",
}: Transaction) {
  seq++;
  db.exec({
    sql: `INSERT INTO transactions (seq, id, source, account_name, transfer_account, amount, currency,
      converted_amount, converted_currency, counterparty, category, duplicate_of, naive_date)
      VALUES (?, ?, 's', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bind: [
      seq,
      id,
      account,
      transfer ?? null,
      amount * 10_000,
      currency,
      converted ? converted[0] * 10_000 : null,
      converted ? converted[1] : null,
      counterparty,
      category,
      duplicateOf ?? null,
      date,
    ],
  });
  return id;
}

const rows = (sql: string, bind?: BindingSpec) => db.selectObjects(sql, bind);
const OCTOBER = { $base: "USD", $from: "2026-10-01", $to: "2026-10-31" };
const summary = (bind: BindingSpec = OCTOBER) => rows(GET_PERIOD_SUMMARY, bind)[0];

describe("GET_OVERVIEW_META", () => {
  it("is empty without transactions", () => {
    expect(rows(GET_OVERVIEW_META)).toEqual([
      { base_currency: null, first_date: null, last_date: null, last_import: expect.any(Number) },
    ]);
  });

  it("has no last import without sources", () => {
    db.exec("DELETE FROM sources");

    expect(rows(GET_OVERVIEW_META)[0]).toMatchObject({ last_import: null });
  });

  it("picks the currency most transactions are in, counting conversions", () => {
    add({ amount: -1, currency: "EUR", account: "Travel", converted: [-1.1, "USD"] });
    add({ amount: -1, currency: "EUR", account: "Travel", converted: [-1.1, "USD"] });
    add({ amount: -1, currency: "EUR", account: "Travel" });

    expect(rows(GET_OVERVIEW_META)[0]).toMatchObject({ base_currency: "USD" });
  });

  it("spans the transactions' dates", () => {
    add({ amount: -1, date: "2025-02-03" });
    add({ amount: -1, date: "2026-10-05" });

    expect(rows(GET_OVERVIEW_META)[0]).toMatchObject({
      first_date: "2025-02-03",
      last_date: "2026-10-05",
    });
  });
});

describe("GET_PERIOD_SUMMARY", () => {
  it("adds up spending and income in the period", () => {
    add({ amount: -40 });
    add({ amount: -2.5 });
    add({ amount: 1000, category: "Salary" });
    add({ amount: -999, date: "2026-09-30" });

    expect(summary()).toMatchObject({ spent: 425_000, income: 10_000_000, transactions: 3 });
  });

  it("uses a conversion to the base currency", () => {
    add({ amount: -20, currency: "EUR", account: "Travel", converted: [-21.8, "USD"] });

    expect(summary()).toMatchObject({ spent: 218_000, unconverted: 0 });
  });

  it("leaves out, and counts, transactions with no amount in the base currency", () => {
    add({ amount: -10 });
    add({ amount: -5000, currency: "INR", account: "India" });
    add({ amount: -20, currency: "EUR", account: "Travel", converted: [-1800, "INR"] });

    expect(summary()).toMatchObject({ spent: 100_000, unconverted: 2, transactions: 3 });
  });

  it("leaves transfers out of spending, income and what needs a category", () => {
    add({ amount: -300, transfer: "Savings" });
    add({ amount: 300, account: "Savings", transfer: "Checking" });

    expect(summary()).toMatchObject({ spent: 0, income: 0, uncategorized: 0, transactions: 2 });
  });

  it("leaves transactions marked as duplicates out of the totals", () => {
    const original = add({ amount: -12, category: "Groceries" });
    add({ amount: -12, duplicateOf: original });

    expect(summary()).toMatchObject({ spent: 120_000, uncategorized: 0 });
  });

  it("counts transactions without a category", () => {
    add({ amount: -1 });
    add({ amount: -1, category: "Groceries" });

    expect(summary()).toMatchObject({ uncategorized: 1 });
  });

  it("includes both ends of the period", () => {
    add({ amount: -1, date: "2026-10-01" });
    add({ amount: -2, date: "2026-10-31" });
    add({ amount: -4, date: "2026-11-01" });

    expect(summary()).toMatchObject({ spent: 30_000 });
  });
});

describe("LIST_DAILY_SPENDING", () => {
  it("adds up each day's spending, oldest first", () => {
    add({ amount: -1, date: "2026-10-07" });
    add({ amount: -2, date: "2026-10-03" });
    add({ amount: -3, date: "2026-10-03" });
    add({ amount: 50, date: "2026-10-04" });

    expect(rows(LIST_DAILY_SPENDING, OCTOBER)).toEqual([
      { date: "2026-10-03", spent: 50_000 },
      { date: "2026-10-07", spent: 10_000 },
    ]);
  });
});

describe("LIST_CATEGORY_SPENDING", () => {
  it("adds up spending per category, and without one", () => {
    add({ amount: -10, category: "Groceries" });
    add({ amount: -5, category: "Groceries" });
    add({ amount: -1 });
    add({ amount: 100, category: "Salary" });

    expect(rows(LIST_CATEGORY_SPENDING, OCTOBER)).toEqual(
      expect.arrayContaining([
        { category: "Groceries", spent: 150_000 },
        { category: null, spent: 10_000 },
      ]),
    );
    expect(rows(LIST_CATEGORY_SPENDING, OCTOBER)).toHaveLength(2);
  });

  it("spells the category as the categories table does", () => {
    add({ amount: -10, category: "groceries" });
    add({ amount: -5, category: "Groceries" });

    expect(rows(LIST_CATEGORY_SPENDING, OCTOBER)).toEqual([
      { category: "Groceries", spent: 150_000 },
    ]);
  });
});

describe("LIST_CATEGORY_PARENTS", () => {
  it("spells parents as the categories table does", () => {
    db.exec("INSERT INTO categories VALUES ('Coffee', 'food')");

    expect(rows(LIST_CATEGORY_PARENTS)).toContainEqual({ name: "Coffee", parent: "Food" });
  });
});

describe("LIST_MONTHLY_TOTALS", () => {
  it("adds up income and spending per month", () => {
    add({ amount: 1000, date: "2026-09-02" });
    add({ amount: -10, date: "2026-09-20" });
    add({ amount: -5, date: "2026-10-01" });
    add({ amount: -300, date: "2026-10-01", transfer: "Savings" });

    expect(rows(LIST_MONTHLY_TOTALS, { ...OCTOBER, $from: "2026-09-01" })).toEqual([
      { month: "2026-09", income: 10_000_000, spent: 100_000 },
      { month: "2026-10", income: 0, spent: 50_000 },
    ]);
  });
});

describe("LIST_ACCOUNT_ACTIVITY", () => {
  const bind = { $from: OCTOBER.$from, $to: OCTOBER.$to };

  it("lists every account, busiest first", () => {
    add({ amount: -1, account: "Travel", currency: "EUR" });
    add({ amount: -1, account: "Travel", currency: "EUR" });
    add({ amount: -1 });

    expect(
      rows(LIST_ACCOUNT_ACTIVITY, bind).map(({ name, transactions }) => [name, transactions]),
    ).toEqual([
      ["Travel", 2],
      ["Checking", 1],
      ["India", 0],
      ["Savings", 0],
    ]);
  });

  it("splits money in, out and transfers, in the account's currency", () => {
    add({ amount: 2560 });
    add({ amount: -40 });
    add({ amount: -300, transfer: "Savings" });
    add({ amount: 50, transfer: "Savings" });
    add({ amount: -24, account: "Travel", currency: "EUR", converted: [-26.4, "USD"] });

    const accounts = rows(LIST_ACCOUNT_ACTIVITY, bind);
    expect(accounts.find(({ name }) => name === "Checking")).toEqual({
      name: "Checking",
      currency: "USD",
      transactions: 4,
      money_in: 25_600_000,
      money_out: 400_000,
      transfers: -2_500_000,
    });
    expect(accounts.find(({ name }) => name === "Travel")).toMatchObject({
      currency: "EUR",
      money_out: 240_000,
    });
  });

  it("counts, but doesn't add up, transactions in another currency", () => {
    add({ amount: -10, account: "Travel", currency: "USD" });

    expect(rows(LIST_ACCOUNT_ACTIVITY, bind)[0]).toMatchObject({
      name: "Travel",
      transactions: 1,
      money_out: 0,
    });
  });

  it("leaves transactions marked as duplicates out of the amounts", () => {
    const original = add({ amount: -12 });
    add({ amount: -12, duplicateOf: original });

    expect(rows(LIST_ACCOUNT_ACTIVITY, bind)[0]).toMatchObject({ money_out: 120_000 });
  });
});

describe("LIST_RECENT_TRANSACTIONS", () => {
  const bind = { $from: OCTOBER.$from, $to: OCTOBER.$to, $limit: 2 };

  it("lists the latest in the period, newest first, later imports first on a day", () => {
    add({ id: "old", amount: -1, date: "2026-10-01" });
    add({ id: "first", amount: -1, date: "2026-10-05" });
    add({ id: "second", amount: -1, date: "2026-10-05" });
    add({ id: "later", amount: -1, date: "2026-11-01" });

    expect(rows(LIST_RECENT_TRANSACTIONS, bind).map(({ id }) => id)).toEqual(["second", "first"]);
  });

  it("includes the category's parent and whether it's marked as a duplicate", () => {
    const original = add({ amount: -1, category: "groceries" });
    add({ amount: -1, duplicateOf: original, date: "2026-10-01" });

    expect(rows(LIST_RECENT_TRANSACTIONS, bind)).toMatchObject([
      { category: "Groceries", category_parent: "Food", duplicate: 0 },
      { category: null, category_parent: null, duplicate: 1 },
    ]);
  });
});
