import sqlite3InitModule, { type BindingSpec, type Database } from "@sqlite.org/sqlite-wasm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureConnection } from "../connection.ts";
import { migrate } from "../migrate.ts";
import { MIGRATIONS } from "../migrations.ts";
import { SOURCE_HASH_SQL, transactionId } from "../../test/fixtures.ts";
import {
  GET_OVERVIEW_META,
  GET_PERIOD_SUMMARY,
  HAS_TRANSACTIONS,
  LIST_ACCOUNT_ACTIVITY,
  LIST_CATEGORY_PARENTS,
  LIST_CATEGORY_SPENDING,
  LIST_CURRENCIES,
  LIST_DAILY_SPENDING,
  LIST_MONTHLY_TOTALS,
  LIST_RECENT_TRANSACTIONS,
  LIST_UNCONVERTED,
} from "./overview.ts";

const sqlite3 = await sqlite3InitModule();

let db: Database;
let count = 0;
beforeEach(() => {
  db = new sqlite3.oo1.DB(":memory:");
  configureConnection(db);
  migrate(db, MIGRATIONS);
  count = 0;
  db.exec(`
    INSERT INTO accounts VALUES ('Checking', 'USD', 'Bank', '••4821'), ('Savings', 'USD', 'Bank', NULL),
      ('Travel', 'EUR', 'Card', '••5512'), ('India', 'INR', 'Bank', NULL);
    INSERT INTO sources (hash, remarks) VALUES (${SOURCE_HASH_SQL}, 'statement.csv');
    INSERT INTO categories VALUES ('Food', NULL), ('Groceries', 'Food'), ('Income', NULL), ('Salary', 'Income');
  `);
});
afterEach(() => db.close());

type Transaction = {
  date?: string;
  account?: string;
  amount: number;
  currency?: string;
  /** The amount in other currencies. */
  conversions?: Record<string, number>;
  category?: string | null;
  transfer?: string;
  duplicateOf?: string;
  counterparty?: string;
  /** When it happened, in seconds since the Unix epoch. */
  timestamp?: number;
};

/** A whole-units amount as the schema stores it, in the currency's stored_decimals. */
function stored(amount: number, currency: string) {
  const decimals = Number(
    db.selectValue("SELECT stored_decimals FROM currencies WHERE code = ?", [currency]),
  );
  return Math.round(amount * 10 ** decimals);
}

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
  timestamp,
}: Transaction) {
  count++;
  const id = transactionId(count);
  db.exec({
    sql: `INSERT INTO transactions (sort_key, timestamp, id, source, account_name,
      transfer_account, amount, currency, counterparty, category, duplicate_of, naive_date)
      VALUES (?, ?, ?, ${SOURCE_HASH_SQL}, ?, ?, ?, ?, ?, ?, ?, ?)`,
    bind: [
      count,
      timestamp ?? null,
      id,
      account,
      transfer ?? null,
      stored(amount, currency),
      currency,
      counterparty,
      category,
      duplicateOf ?? null,
      date,
    ],
  });
  for (const [to, value] of Object.entries(conversions)) {
    db.exec({ sql: "INSERT INTO conversions VALUES (?, ?, ?)", bind: [id, to, stored(value, to)] });
  }
  return id;
}

const rows = (sql: string, bind?: BindingSpec) => db.selectObjects(sql, bind);
const OCTOBER = { $display: "USD", $from: "2026-10-01", $to: "2026-10-31" };
const OCTOBER_DATES = { $from: OCTOBER.$from, $to: OCTOBER.$to };
const summary = (bind: BindingSpec = OCTOBER) => rows(GET_PERIOD_SUMMARY, bind)[0];
/** An account without a display currency. */
const addCash = () => db.exec("INSERT INTO accounts VALUES ('Cash', NULL, 'Cash', NULL)");

/** `$fallbacks` as the queries take it: amounts in whole units, of a currency with two decimals. */
const fallbacks = (...amounts: [id: string, amount: number][]) =>
  JSON.stringify(amounts.map(([id, amount]) => [id, Math.round(amount * 100)]));

describe("amounts from exchange rates ($fallbacks)", () => {
  it("counts a transaction without a stored amount through the one it's given", () => {
    add({ amount: -20 });
    const cab = add({ amount: -10, currency: "GBP" });
    const refund = add({ amount: 4, currency: "GBP" });

    expect(summary()).toMatchObject({ spent: 20, income: 0 });
    expect(summary({ ...OCTOBER, $fallbacks: fallbacks([cab, -12.5], [refund, 5]) })).toMatchObject(
      { spent: 32.5, income: 5 },
    );
  });

  it("says how many it counted that way, and how many it still left out", () => {
    add({ amount: -20 });
    add({ amount: -24, currency: "EUR", conversions: { USD: -26.4 } });
    const cab = add({ amount: -10, currency: "GBP" });
    add({ amount: -30, currency: "GBP" });
    add({ amount: -40, currency: "JPY" });

    expect(summary()).toMatchObject({ unconverted: 3, estimated: 0, skipped: 3 });
    expect(summary({ ...OCTOBER, $fallbacks: fallbacks([cab, -12.5]) })).toMatchObject({
      unconverted: 3,
      estimated: 1,
      skipped: 2,
    });
  });

  it("never uses one for a transaction with a stored amount", () => {
    const own = add({ amount: -20 });
    const converted = add({ amount: -24, currency: "EUR", conversions: { USD: -26.4 } });

    expect(
      summary({ ...OCTOBER, $fallbacks: fallbacks([own, -999], [converted, -999]) }),
    ).toMatchObject({ spent: 46.4, unconverted: 0, estimated: 0, skipped: 0 });
  });

  it("never uses one for a transaction in an account without a display currency", () => {
    addCash();
    const cash = add({ account: "Cash", amount: -10, currency: "GBP" });

    expect(
      summary({ ...OCTOBER, $display: "GBP", $fallbacks: fallbacks([cash, -999]) }),
    ).toMatchObject({ spent: 10, estimated: 0, skipped: 0 });
  });

  it("leaves a transfer or a duplicate out of the totals and the counts, whatever it's given", () => {
    const first = add({ amount: -10, currency: "GBP" });
    const duplicate = add({ amount: -10, currency: "GBP", duplicateOf: first });
    const transfer = add({ amount: -10, currency: "GBP", transfer: "Savings" });

    expect(
      summary({
        ...OCTOBER,
        $fallbacks: fallbacks([first, -12.5], [duplicate, -12.5], [transfer, -12.5]),
      }),
    ).toMatchObject({ spent: 12.5, unconverted: 1, estimated: 1, skipped: 0 });
  });

  it("does without amounts for transactions there aren't, or with none at all", () => {
    add({ amount: -10, currency: "GBP" });

    for (const $fallbacks of [fallbacks(["nobody", -5]), "[]", null])
      expect(summary({ ...OCTOBER, $fallbacks })).toMatchObject({
        spent: 0,
        estimated: 0,
        skipped: 1,
      });
  });

  it("counts an amount of zero as an amount", () => {
    const cab = add({ amount: -10, currency: "GBP" });

    expect(summary({ ...OCTOBER, $fallbacks: fallbacks([cab, 0]) })).toMatchObject({
      spent: 0,
      estimated: 1,
      skipped: 0,
    });
  });

  it("counts them in the spending of each day, category and month", () => {
    add({ amount: -20, category: "Groceries" });
    const cab = add({ date: "2026-10-06", amount: -10, currency: "GBP", category: "Groceries" });
    const bind = { ...OCTOBER, $fallbacks: fallbacks([cab, -12.5]) };

    expect(rows(LIST_DAILY_SPENDING, bind)).toEqual([
      { date: "2026-10-05", spent: 20 },
      { date: "2026-10-06", spent: 12.5 },
    ]);
    expect(rows(LIST_CATEGORY_SPENDING, bind)).toEqual([{ category: "Groceries", spent: 32.5 }]);
    expect(rows(LIST_MONTHLY_TOTALS, bind)).toEqual([{ month: "2026-10", income: 0, spent: 32.5 }]);
  });

  it("counts them in an account's money in and out, in the account's own currency", () => {
    const cab = add({ amount: -10, currency: "GBP" });
    const taxi = add({ account: "Travel", amount: -30, currency: "GBP" });
    const bind = {
      $from: OCTOBER.$from,
      $to: OCTOBER.$to,
      $fallbacks: fallbacks([cab, -12.5], [taxi, -35]),
    };

    const accounts = rows(LIST_ACCOUNT_ACTIVITY, bind);
    expect(accounts.find(({ name }) => name === "Checking")).toMatchObject({ money_out: 12.5 });
    expect(accounts.find(({ name }) => name === "Travel")).toMatchObject({ money_out: 35 });
  });

  it("lists a recent transaction's as its amount in the display currency, marked as estimated", () => {
    const cab = add({ amount: -10, currency: "GBP", timestamp: 3 });
    add({ amount: -24, currency: "EUR", conversions: { USD: -26.4 }, timestamp: 2 });
    add({ amount: -20, timestamp: 1 });
    add({ amount: -40, currency: "JPY", timestamp: 0 });
    const bind = { ...OCTOBER, $limit: 5, $fallbacks: fallbacks([cab, -12.5]) };

    expect(rows(LIST_RECENT_TRANSACTIONS, bind)).toMatchObject([
      { conversion_amount: -1250, conversion_decimals: 2, conversion_estimated: 1 },
      { conversion_amount: -2640, conversion_decimals: 2, conversion_estimated: 0 },
      { conversion_amount: null, conversion_decimals: null, conversion_estimated: 0 },
      { conversion_amount: null, conversion_decimals: null, conversion_estimated: 0 },
    ]);
  });
});

describe("LIST_UNCONVERTED", () => {
  const ALL = { $from: "0000-01-01", $to: "9999-12-31" };
  const unconverted = (bind: BindingSpec = ALL) => rows(LIST_UNCONVERTED, bind);

  it("lists a transaction in another currency than its account's, without a conversion to it", () => {
    const cab = add({ amount: -10, currency: "GBP" });

    expect(unconverted()).toEqual([
      {
        id: cab,
        naive_date: "2026-10-05",
        currency: "GBP",
        amount: -1000,
        decimals: 2,
        display: "USD",
        display_decimals: 2,
        conversions: "{}",
      },
    ]);
  });

  it("lists its conversions to other currencies, each in its own decimals", () => {
    add({ amount: -10, currency: "GBP", conversions: { JPY: -2000, EUR: -11.5 } });

    const [row] = unconverted();
    expect(JSON.parse(row!.conversions as string)).toEqual({
      JPY: { amount: -2000, decimals: 0 },
      EUR: { amount: -1150, decimals: 2 },
    });
  });

  it("leaves out a transaction in its account's currency, or converted to it", () => {
    add({ amount: -20 });
    add({ amount: -24, currency: "EUR", conversions: { USD: -26.4 } });

    expect(unconverted()).toEqual([]);
  });

  it("goes by each account's own display currency", () => {
    // Converted to dollars, which isn't what Travel displays in.
    const taxi = add({
      account: "Travel",
      amount: -30,
      currency: "GBP",
      conversions: { USD: -40 },
    });

    expect(unconverted()).toMatchObject([{ id: taxi, display: "EUR" }]);
  });

  it("leaves out the transactions of an account without a display currency", () => {
    addCash();
    add({ account: "Cash", amount: -10, currency: "GBP" });

    expect(unconverted()).toEqual([]);
  });

  it("lists transfers and duplicates too", () => {
    const first = add({ amount: -10, currency: "GBP" });
    add({ amount: -10, currency: "GBP", duplicateOf: first });
    add({ amount: -10, currency: "GBP", transfer: "Savings" });

    expect(unconverted()).toHaveLength(3);
  });

  it("only lists those from $from to $to, inclusive", () => {
    const dates = ["2026-09-30", "2026-10-01", "2026-10-31", "2026-11-01"];
    const ids = dates.map((date) => add({ date, amount: -10, currency: "GBP" }));

    expect(unconverted(OCTOBER_DATES).map(({ id }) => id)).toEqual([ids[1], ids[2]]);
  });
});

describe("LIST_CURRENCIES", () => {
  const currencies = () => rows(LIST_CURRENCIES).map(({ currency }) => currency);

  it("is empty without transactions", () => {
    expect(currencies()).toEqual([]);
  });

  it("lists the display currency with the most transactions first, ignoring conversions", () => {
    add({ amount: -1 });
    add({ amount: -1, currency: "EUR", account: "Travel", conversions: { USD: -1.1, INR: -90 } });
    add({ amount: -1, currency: "EUR", account: "Travel", conversions: { USD: -1.1, INR: -90 } });

    expect(currencies()).toEqual(["EUR", "USD"]);
  });

  it("lists an account's display currency for its transactions in other currencies", () => {
    add({ amount: -1, account: "Travel" });

    expect(currencies()).toEqual(["EUR"]);
  });

  it("lists the currencies of transactions in accounts without a display currency", () => {
    addCash();
    add({ amount: -1, account: "Cash", currency: "GBP" });
    add({ amount: -1, account: "Cash" });
    add({ amount: -1 });

    expect(currencies()).toEqual(["USD", "GBP"]);
  });

  it("breaks a tie by the currency's name", () => {
    add({ amount: -1 });
    add({ amount: -1, currency: "EUR", account: "Travel" });

    expect(currencies()).toEqual(["EUR", "USD"]);
  });

  it("counts each account's currencies from an index, without reading the transactions", () => {
    const plan = db
      .selectObjects(`EXPLAIN QUERY PLAN ${LIST_CURRENCIES}`)
      .map(({ detail }) => detail);

    expect(plan).toContain("SCAN transactions USING COVERING INDEX transactions_account_currency");
  });
});

describe("GET_OVERVIEW_META", () => {
  it("is empty without transactions", () => {
    expect(rows(GET_OVERVIEW_META)).toEqual([
      { first_date: null, last_date: null, last_import: expect.any(Number) },
    ]);
  });

  it("has no last import without sources", () => {
    db.exec("DELETE FROM sources");

    expect(rows(GET_OVERVIEW_META)[0]).toMatchObject({ last_import: null });
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

describe("HAS_TRANSACTIONS", () => {
  const inOctober = () => rows(HAS_TRANSACTIONS, { $from: "2026-10-01", $to: "2026-10-31" });

  it("finds none when every transaction is outside the period", () => {
    add({ amount: -1, date: "2026-09-30" });
    add({ amount: -1, date: "2026-11-01" });

    expect(inOctober()).toEqual([{ found: 0 }]);
  });

  it("finds one on the period's first day", () => {
    add({ amount: -1, date: "2026-10-01" });

    expect(inOctober()).toEqual([{ found: 1 }]);
  });

  it("finds one on the period's last day", () => {
    add({ amount: -1, date: "2026-10-31" });

    expect(inOctober()).toEqual([{ found: 1 }]);
  });

  it("finds a transfer, though it's left out of spending and income", () => {
    add({ amount: -1, transfer: "Savings" });

    expect(inOctober()).toEqual([{ found: 1 }]);
  });

  it("finds a duplicate, though it's left out of spending and income", () => {
    add({ amount: -1, duplicateOf: add({ amount: -1, date: "2026-09-30" }) });

    expect(inOctober()).toEqual([{ found: 1 }]);
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

  it("reads each amount in its currency's stored decimals", () => {
    db.exec("INSERT INTO accounts VALUES ('Japan', 'JPY', 'Bank', NULL)");
    db.exec("UPDATE currencies SET stored_decimals = 4 WHERE code = 'USD'");
    add({ amount: -0.1234 });
    add({ amount: -1500, account: "Japan", currency: "JPY" });

    expect(summary()!.spent).toBeCloseTo(0.1234, 10);
    expect(summary({ ...OCTOBER, $display: "JPY" })!.spent).toBe(1500);
  });

  it("covers accounts shown in the display currency, and it in accounts without one", () => {
    addCash();
    add({ amount: -10 });
    add({ amount: -5, account: "Cash" });
    // Neither in an account shown in USD nor in USD itself.
    add({ amount: -20, currency: "EUR", account: "Travel", conversions: { USD: -22 } });
    add({ amount: -7, currency: "EUR", account: "Cash", conversions: { USD: -7.7 } });

    expect(summary()).toMatchObject({ spent: 15, transactions: 2, uncategorized: 2 });
  });

  it("covers the overview in the display currency asked for", () => {
    addCash();
    add({ amount: -10, account: "Travel", conversions: { EUR: -9 } });
    add({ amount: -20, currency: "EUR" });
    add({ amount: -7, currency: "EUR", account: "Cash" });

    expect(summary({ ...OCTOBER, $display: "EUR" })).toMatchObject({
      spent: 16,
      transactions: 2,
    });
  });

  it("uses a conversion to the display currency", () => {
    add({ amount: -20, currency: "EUR", conversions: { USD: -21.8 } });

    expect(summary()).toMatchObject({ spent: 21.8, unconverted: 0 });
  });

  it("counts a transaction with several conversions once, in the display currency", () => {
    add({ amount: -20, currency: "EUR", conversions: { INR: -1800, USD: -21.8 } });

    expect(summary()).toMatchObject({ spent: 21.8, transactions: 1, unconverted: 0 });
  });

  it("leaves out, and counts as unconverted, those with no amount in the display currency", () => {
    add({ amount: -10 });
    add({ amount: -20, currency: "EUR" });
    add({ amount: -20, currency: "EUR", conversions: { INR: -1800 } });

    expect(summary()).toMatchObject({ spent: 10, transactions: 3, unconverted: 2 });
  });

  it("doesn't count transfers or duplicates as unconverted", () => {
    const original = add({ amount: -20, currency: "EUR", conversions: { USD: -22 } });
    add({ amount: -20, currency: "EUR", duplicateOf: original });
    add({ amount: -20, currency: "EUR", transfer: "Savings" });

    expect(summary()).toMatchObject({ spent: 22, unconverted: 0 });
  });

  it("counts the spending in other currencies, without transfers or duplicates", () => {
    addCash();
    const original = add({ amount: -20, currency: "EUR", conversions: { USD: -22 } });
    add({ amount: -20, currency: "EUR" });
    add({ amount: 30, currency: "EUR", conversions: { USD: 33 } });
    add({ amount: -20, currency: "EUR", duplicateOf: original });
    add({ amount: -20, currency: "EUR", transfer: "Savings" });
    add({ amount: -1 });
    add({ amount: -1, account: "Cash" });

    expect(summary()).toMatchObject({ transactions: 7, foreign_currency_spends: 2 });
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

    expect(rows(LIST_ACCOUNT_ACTIVITY, bind).map(({ name }) => name)).toEqual([
      "Travel",
      "Checking",
      "India",
      "Savings",
    ]);
  });

  it("splits money in and out, leaving out transfers, in the account's currency", () => {
    add({ amount: 2560 });
    add({ amount: -40 });
    add({ amount: -300, transfer: "Savings" });
    add({ amount: 50, transfer: "Savings" });
    add({ amount: -24, account: "Travel", currency: "EUR", conversions: { USD: -26.4 } });

    const accounts = rows(LIST_ACCOUNT_ACTIVITY, bind);
    expect(accounts.find(({ name }) => name === "Checking")).toEqual({
      name: "Checking",
      type: "Bank",
      identifier: "••4821",
      currencies: 1,
      currency: "USD",
      money_in: 2560,
      money_out: 40,
    });
    expect(accounts.find(({ name }) => name === "Travel")).toMatchObject({
      currency: "EUR",
      money_out: 24,
    });
  });

  it("counts a transaction in another currency through its conversion to the account's", () => {
    add({ amount: -10, account: "Travel", conversions: { INR: -830, EUR: -9.2 } });
    add({ amount: 5, account: "Travel", conversions: { EUR: 4.6 } });

    expect(rows(LIST_ACCOUNT_ACTIVITY, bind)[0]).toMatchObject({
      name: "Travel",
      currency: "EUR",
      money_in: 4.6,
      money_out: 9.2,
    });
  });

  it("orders by, but doesn't add up, transactions with no amount in the account's currency", () => {
    add({ amount: -10, account: "Travel", conversions: { INR: -830 } });

    expect(rows(LIST_ACCOUNT_ACTIVITY, bind)[0]).toMatchObject({ name: "Travel", money_out: 0 });
  });

  it("gives an account without an identifier as null", () => {
    expect(rows(LIST_ACCOUNT_ACTIVITY, bind).find(({ name }) => name === "India")).toMatchObject({
      type: "Bank",
      identifier: null,
    });
  });

  describe("an account without a display currency", () => {
    const cash = () => rows(LIST_ACCOUNT_ACTIVITY, bind).find(({ name }) => name === "Cash");
    beforeEach(addCash);

    it("has amounts in the one currency its transactions are in", () => {
      add({ amount: -5, account: "Cash", currency: "GBP" });
      add({ amount: 2, account: "Cash", currency: "GBP" });

      expect(cash()).toEqual({
        name: "Cash",
        type: "Cash",
        identifier: null,
        currencies: 1,
        currency: "GBP",
        money_in: 2,
        money_out: 5,
      });
    });

    it("has none when its transactions are in several currencies", () => {
      add({ amount: -5, account: "Cash", currency: "GBP" });
      add({ amount: -2, account: "Cash", currency: "EUR" });

      expect(cash()).toMatchObject({
        currencies: 2,
        currency: null,
        money_in: null,
        money_out: null,
      });
    });

    it("goes by the transactions counted, not transfers or duplicates", () => {
      const original = add({ amount: -5, account: "Cash", currency: "GBP" });
      add({ amount: -300, account: "Cash", currency: "EUR", transfer: "Checking" });
      add({ amount: -5, account: "Cash", currency: "USD", duplicateOf: original });

      expect(cash()).toMatchObject({ currencies: 1, currency: "GBP", money_out: 5 });
    });

    it("has none without transactions in the period", () => {
      add({ amount: -5, account: "Cash", currency: "GBP", date: "2026-09-30" });

      expect(cash()).toMatchObject({ currencies: 0, currency: null, money_out: null });
    });
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

  it("lists a day's with a time first, as the transactions are listed", () => {
    const timed = add({ amount: -1, timestamp: Date.parse("2026-10-05T09:00Z") / 1000 });
    add({ amount: -1 });
    add({ amount: -1, date: "2026-10-01" });

    expect(rows(LIST_RECENT_TRANSACTIONS, bind)[0]!.id).toBe(timed);
  });

  it("includes the category's parent and whether it's marked as a duplicate", () => {
    const original = add({ amount: -1, category: "groceries" });
    add({ amount: -1, duplicateOf: original, date: "2026-10-01" });

    expect(rows(LIST_RECENT_TRANSACTIONS, bind)).toMatchObject([
      { category: "Groceries", category_parent: "Food", duplicate: 0 },
      { category: null, category_parent: null, duplicate: 1 },
    ]);
  });

  it("has the amount as stored, and only its conversion to the display currency", () => {
    db.exec("UPDATE currencies SET stored_decimals = 3 WHERE code = 'EUR'");
    add({ amount: -0.333, currency: "EUR", conversions: { INR: -30, USD: -0.36 } });
    add({ amount: -1, date: "2026-10-01" });

    expect(rows(LIST_RECENT_TRANSACTIONS, bind)).toMatchObject([
      {
        amount: -333,
        decimals: 3,
        currency: "EUR",
        conversion_amount: -36,
        conversion_decimals: 2,
      },
      {
        amount: -100,
        decimals: 2,
        currency: "USD",
        conversion_amount: null,
        conversion_decimals: null,
      },
    ]);
  });

  it("lists only those in the overview in the display currency", () => {
    addCash();
    const checking = add({ amount: -1, date: "2026-10-01" });
    const cash = add({ amount: -1, account: "Cash", date: "2026-10-02" });
    // In USD, but in an account shown in EUR.
    add({ amount: -1, account: "Travel", date: "2026-10-03" });
    add({ amount: -1, account: "Cash", currency: "EUR", date: "2026-10-04" });

    expect(rows(LIST_RECENT_TRANSACTIONS, bind).map(({ id }) => id)).toEqual([cash, checking]);
  });
});
