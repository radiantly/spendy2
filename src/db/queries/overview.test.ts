import sqlite3InitModule, { type BindingSpec, type Database } from "@sqlite.org/sqlite-wasm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureConnection } from "../connection.ts";
import { migrate } from "../migrate.ts";
import { MIGRATIONS } from "../migrations.ts";
import { reduce, type Rational } from "../../lib/rational.ts";
import { SOURCE_HASH_SQL, transactionId } from "../../test/fixtures.ts";
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
    INSERT INTO sources (hash, remarks) VALUES (${SOURCE_HASH_SQL}, 'statement.csv');
    INSERT INTO categories VALUES ('Food', NULL), ('Groceries', 'Food'), ('Income', NULL), ('Salary', 'Income');
  `);
});
afterEach(() => db.close());

type Transaction = {
  date?: string;
  account?: string;
  amount: number | Rational;
  currency?: string;
  /** The amount in other currencies. */
  conversions?: Record<string, number>;
  category?: string | null;
  transfer?: string;
  duplicateOf?: string;
  counterparty?: string;
};

/** A whole-units amount, to the cent, as the schema stores it. */
const stored = (amount: number | Rational) =>
  typeof amount === "number" ? reduce(Math.round(amount * 100), 100)! : amount;

/** Inserts a transaction; amounts are in whole units. Returns its id. */
function add({
  date = "2026-10-05",
  account = "Checking",
  amount,
  currency = "USD",
  conversions = {},
  category = null,
  transfer,
  duplicateOf,
  counterparty = "Somewhere",
}: Transaction) {
  seq++;
  const id = transactionId(seq);
  const { numerator, denominator } = stored(amount);
  db.exec({
    sql: `INSERT INTO transactions (seq, id, source, account_name, transfer_account, amount_numerator,
      amount_denominator, currency, counterparty, category, duplicate_of, naive_date)
      VALUES (?, ?, ${SOURCE_HASH_SQL}, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bind: [
      seq,
      id,
      account,
      transfer ?? null,
      numerator,
      denominator,
      currency,
      counterparty,
      category,
      duplicateOf ?? null,
      date,
    ],
  });
  for (const [to, value] of Object.entries(conversions)) {
    const conversion = stored(value);
    db.exec({
      sql: "INSERT INTO conversions VALUES (?, ?, ?, ?)",
      bind: [id, to, conversion.numerator, conversion.denominator],
    });
  }
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

  it("picks the currency most transactions have an amount in, counting conversions", () => {
    add({ amount: -1 });
    add({ amount: -1, currency: "EUR", account: "Travel", conversions: { USD: -1.1, INR: -90 } });
    add({ amount: -1, currency: "EUR", account: "Travel", conversions: { USD: -1.1, INR: -90 } });

    expect(rows(GET_OVERVIEW_META)[0]).toMatchObject({ base_currency: "USD" });
  });

  it("counts a converted transaction in its own currency too", () => {
    add({ amount: -1, currency: "EUR", account: "Travel", conversions: { USD: -1.1 } });
    add({ amount: -1, currency: "EUR", account: "Travel", conversions: { USD: -1.1 } });
    add({ amount: -1, currency: "EUR", account: "Travel" });

    expect(rows(GET_OVERVIEW_META)[0]).toMatchObject({ base_currency: "EUR" });
  });

  it("breaks a tie by the currency's name", () => {
    add({ amount: -1 });
    add({ amount: -1, currency: "EUR", account: "Travel" });

    expect(rows(GET_OVERVIEW_META)[0]).toMatchObject({ base_currency: "EUR" });
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

    expect(summary()).toMatchObject({ spent: 42.5, income: 1000, transactions: 3 });
  });

  it("adds up fractions", () => {
    for (let i = 0; i < 3; i++) add({ amount: { numerator: -1, denominator: 3 } });

    expect(summary()!.spent).toBeCloseTo(1, 10);
  });

  it("uses a conversion to the base currency", () => {
    add({ amount: -20, currency: "EUR", account: "Travel", conversions: { USD: -21.8 } });

    expect(summary()).toMatchObject({ spent: 21.8, unconverted: 0 });
  });

  it("counts a transaction with several conversions once, in the base currency", () => {
    add({
      amount: -20,
      currency: "EUR",
      account: "Travel",
      conversions: { INR: -1800, USD: -21.8 },
    });

    expect(summary()).toMatchObject({ spent: 21.8, transactions: 1, unconverted: 0 });
  });

  it("leaves out, and counts, transactions with no amount in the base currency", () => {
    add({ amount: -10 });
    add({ amount: -5000, currency: "INR", account: "India" });
    add({ amount: -20, currency: "EUR", account: "Travel", conversions: { INR: -1800 } });

    expect(summary()).toMatchObject({ spent: 10, unconverted: 2, transactions: 3 });
  });

  it("leaves transfers out of spending, income and what needs a category", () => {
    add({ amount: -300, transfer: "Savings" });
    add({ amount: 300, account: "Savings", transfer: "Checking" });

    expect(summary()).toMatchObject({ spent: 0, income: 0, uncategorized: 0, transactions: 2 });
  });

  it("leaves transactions marked as duplicates out of the totals", () => {
    const original = add({ amount: -12, category: "Groceries" });
    add({ amount: -12, duplicateOf: original });

    expect(summary()).toMatchObject({ spent: 12, uncategorized: 0 });
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

    expect(summary()).toMatchObject({ spent: 3 });
  });
});

describe("LIST_DAILY_SPENDING", () => {
  it("adds up each day's spending, oldest first", () => {
    add({ amount: -1, date: "2026-10-07" });
    add({ amount: -2, date: "2026-10-03" });
    add({ amount: -3, date: "2026-10-03" });
    add({ amount: 50, date: "2026-10-04" });

    expect(rows(LIST_DAILY_SPENDING, OCTOBER)).toEqual([
      { date: "2026-10-03", spent: 5 },
      { date: "2026-10-07", spent: 1 },
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
        { category: "Groceries", spent: 15 },
        { category: null, spent: 1 },
      ]),
    );
    expect(rows(LIST_CATEGORY_SPENDING, OCTOBER)).toHaveLength(2);
  });

  it("spells the category as the categories table does", () => {
    add({ amount: -10, category: "groceries" });
    add({ amount: -5, category: "Groceries" });

    expect(rows(LIST_CATEGORY_SPENDING, OCTOBER)).toEqual([{ category: "Groceries", spent: 15 }]);
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
      { month: "2026-09", income: 1000, spent: 10 },
      { month: "2026-10", income: 0, spent: 5 },
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
    add({ amount: -24, account: "Travel", currency: "EUR", conversions: { USD: -26.4 } });

    const accounts = rows(LIST_ACCOUNT_ACTIVITY, bind);
    expect(accounts.find(({ name }) => name === "Checking")).toEqual({
      name: "Checking",
      currency: "USD",
      transactions: 4,
      money_in: 2560,
      money_out: 40,
      transfers: -250,
    });
    expect(accounts.find(({ name }) => name === "Travel")).toMatchObject({
      currency: "EUR",
      money_out: 24,
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

  it("leaves out accounts without a default currency, for now", () => {
    db.exec("INSERT INTO accounts VALUES ('Cash', NULL)");
    add({ amount: -5, account: "Cash" });

    expect(rows(LIST_ACCOUNT_ACTIVITY, bind).map(({ name }) => name)).not.toContain("Cash");
  });

  it("leaves transactions marked as duplicates out of the amounts", () => {
    const original = add({ amount: -12 });
    add({ amount: -12, duplicateOf: original });

    expect(rows(LIST_ACCOUNT_ACTIVITY, bind)[0]).toMatchObject({ money_out: 12 });
  });
});

describe("LIST_RECENT_TRANSACTIONS", () => {
  const bind = { ...OCTOBER, $limit: 2 };

  it("lists the latest in the period, newest first, later imports first on a day", () => {
    add({ amount: -1, date: "2026-10-01" });
    const first = add({ amount: -1, date: "2026-10-05" });
    const second = add({ amount: -1, date: "2026-10-05" });
    add({ amount: -1, date: "2026-11-01" });

    expect(rows(LIST_RECENT_TRANSACTIONS, bind).map(({ id }) => id)).toEqual([second, first]);
  });

  it("includes the category's parent and whether it's marked as a duplicate", () => {
    const original = add({ amount: -1, category: "groceries" });
    add({ amount: -1, duplicateOf: original, date: "2026-10-01" });

    expect(rows(LIST_RECENT_TRANSACTIONS, bind)).toMatchObject([
      { category: "Groceries", category_parent: "Food", duplicate: 0 },
      { category: null, category_parent: null, duplicate: 1 },
    ]);
  });

  it("has the exact amount, and only its conversion to the base currency", () => {
    add({
      amount: { numerator: -1, denominator: 3 },
      currency: "EUR",
      account: "Travel",
      conversions: { INR: -30, USD: -0.36 },
    });
    add({ amount: -1, date: "2026-10-01" });

    expect(rows(LIST_RECENT_TRANSACTIONS, bind)).toMatchObject([
      {
        amount_numerator: -1,
        amount_denominator: 3,
        currency: "EUR",
        base_numerator: -9,
        base_denominator: 25,
      },
      {
        amount_numerator: -1,
        amount_denominator: 1,
        currency: "USD",
        base_numerator: null,
        base_denominator: null,
      },
    ]);
  });
});
