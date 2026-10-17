/**
 * Generated test data: a few accounts and categories, and transactions spread
 * over ten years. Deterministic apart from the transaction ids.
 */
import { createHash } from "node:crypto";
import type { Database } from "@sqlite.org/sqlite-wasm";
import { currencyDecimals } from "../src/lib/money.ts";
import { reduce } from "../src/lib/rational.ts";

/** As the accounts table has it; `currency` is the display currency. */
type Account = { name: string; currency: string | null; type: string; identifier: string | null };

const ACCOUNTS = [
  { name: "Everyday Checking", currency: "USD", type: "Bank", identifier: "••4821" },
  { name: "Rewards Credit Card", currency: "USD", type: "Card", identifier: "••3307" },
  { name: "High-Yield Savings", currency: "USD", type: "Bank", identifier: "••1190" },
  { name: "Travel Card", currency: "EUR", type: "Card", identifier: "••5512" },
  { name: "India Savings", currency: "INR", type: "Bank", identifier: null },
] as const satisfies readonly Account[];

/** Trades in several currencies, so has no display currency. */
const BROKERAGE: Account = {
  name: "Global Brokerage",
  currency: null,
  type: "Brokerage",
  identifier: "••7730",
};

/** What the brokerage trades in each currency, and about how much of it a dollar buys. */
const MARKETS = [
  { currency: "USD", perDollar: 1, tickers: ["AAPL", "MSFT", "VTI"] },
  { currency: "EUR", perDollar: 0.92, tickers: ["ASML", "SAP", "VWCE"] },
  { currency: "GBP", perDollar: 0.79, tickers: ["HSBA", "ULVR", "VUSA"] },
  { currency: "JPY", perDollar: 150, tickers: ["7203.T", "6758.T"] },
] as const;

/** Spending categories, each with typical counterparties and amounts. */
const SPENDING = [
  {
    parent: "Housing",
    name: "Utilities",
    counterparties: ["City Power & Light", "Metro Water", "FiberNet"],
    range: [40, 180],
  },
  {
    parent: "Food",
    name: "Groceries",
    counterparties: ["Corner Market", "FreshCo", "Whole Harvest", "Aldi"],
    range: [8, 160],
  },
  {
    parent: "Food",
    name: "Dining out",
    counterparties: ["Café Lumen", "Noodle Bar", "Taqueria Sol", "The Daily Grind"],
    range: [4, 90],
  },
  {
    parent: "Transport",
    name: "Transit",
    counterparties: ["BVG Berlin", "Metro Card", "Uber", "Lyft"],
    range: [2, 45],
  },
  { parent: "Transport", name: "Fuel", counterparties: ["Shell", "Chevron"], range: [25, 80] },
  {
    parent: "Shopping",
    name: "Clothes",
    counterparties: ["Uniqlo", "Patagonia", "H&M"],
    range: [15, 220],
  },
  {
    parent: "Shopping",
    name: "Electronics",
    counterparties: ["Best Buy", "Apple Store", "SQ *KINDLING"],
    range: [10, 900],
  },
  {
    parent: "Health",
    name: "Pharmacy",
    counterparties: ["CVS Pharmacy", "Walgreens"],
    range: [5, 70],
  },
  {
    parent: "Subscriptions",
    name: "Streaming",
    counterparties: ["Netflix", "Spotify"],
    range: [10, 20],
  },
  {
    parent: "Subscriptions",
    name: "Software",
    counterparties: ["GitHub", "1Password", "iCloud"],
    range: [3, 15],
  },
] as const;

const REMARKS = ["split with Sam", "reimbursable", "gift", "refund pending", "annual", "work trip"];

/** A small deterministic PRNG (mulberry32), so the same seed gives the same data. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type TestDataOptions = {
  /**
   * Also a brokerage account trading in USD, EUR, GBP and JPY, with about
   * 3% of the transactions. Without it, the data is as it always was.
   */
  brokerage?: boolean;
};

/** Fills a migrated, empty database with `count` realistic transactions. */
export function generateTestData(
  db: Database,
  count: number,
  { brokerage = false }: TestDataOptions = {},
) {
  const rand = random(42);
  const pick = <T>(items: readonly T[]) => items[Math.floor(rand() * items.length)]!;
  const between = (min: number, max: number) => min + rand() * (max - min);
  /** To the currency's smallest unit (the cent, or the yen), as the fraction the schema stores. */
  const amount = (value: number, currency: string) => {
    const units = 10 ** currencyDecimals(currency);
    const { numerator, denominator } = reduce(Math.round(value * units), units)!;
    return [numerator, denominator];
  };

  db.transaction(() => {
    for (const account of brokerage ? [...ACCOUNTS, BROKERAGE] : ACCOUNTS)
      db.exec({
        sql: "INSERT INTO accounts VALUES (?, ?, ?, ?)",
        bind: [account.name, account.currency, account.type, account.identifier],
      });

    const parents = [
      ...new Set([...SPENDING.map((c) => c.parent), "Income", ...(brokerage ? ["Investing"] : [])]),
    ];
    for (const parent of parents)
      db.exec({ sql: "INSERT INTO categories VALUES (?, NULL)", bind: [parent] });
    for (const { parent, name } of SPENDING)
      db.exec({ sql: "INSERT INTO categories VALUES (?, ?)", bind: [name, parent] });
    for (const name of ["Rent", "Salary", "Interest"])
      db.exec({
        sql: "INSERT INTO categories VALUES (?, ?)",
        bind: [name, name === "Rent" ? "Housing" : "Income"],
      });
    if (brokerage)
      for (const [name, parent] of [
        ["Trades", "Investing"],
        ["Fees", "Investing"],
        ["Dividends", "Income"],
      ])
        db.exec({ sql: "INSERT INTO categories VALUES (?, ?)", bind: [name, parent] });

    const insert = db.prepare(`
      INSERT INTO transactions (seq, id, source, account_name, transfer_account, amount_numerator,
        amount_denominator, currency, counterparty, category, naive_date, remarks)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertConversion = db.prepare(`
      INSERT INTO conversions (transaction_id, currency, amount_numerator, amount_denominator)
      VALUES (?, ?, ?, ?)
    `);
    const insertSource = db.prepare("INSERT OR IGNORE INTO sources (hash, remarks) VALUES (?, ?)");

    // Spread over the past ten years, oldest first, so seq follows the dates.
    const end = Date.UTC(2026, 9, 10);
    const start = end - 10 * 365 * 86_400_000;
    try {
      for (let seq = 1; seq <= count; seq++) {
        const date = new Date(start + ((end - start) * seq) / count).toISOString().slice(0, 10);
        // As if each month were imported from its own statement.
        const statement = `statement ${date.slice(0, 7)}.csv`;
        const source = createHash("sha256").update(statement).digest();
        insertSource.bind([source, statement]).stepReset();

        const kind = rand();
        let row: {
          account: Account;
          currency: string;
          transfer?: string;
          value: number;
          counterparty: string;
          category: string | null;
        };
        if (kind < 0.02) {
          row = {
            account: ACCOUNTS[0],
            currency: ACCOUNTS[0].currency,
            value: between(2000, 4000),
            counterparty: "Acme Corp Payroll",
            category: "Salary",
          };
        } else if (kind < 0.03) {
          row = {
            account: ACCOUNTS[0],
            currency: ACCOUNTS[0].currency,
            value: -between(1200, 1400),
            counterparty: "Parkside Apartments",
            category: "Rent",
          };
        } else if (kind < 0.05) {
          row = {
            account: ACCOUNTS[0],
            currency: ACCOUNTS[0].currency,
            transfer: ACCOUNTS[2].name,
            value: -between(100, 500),
            counterparty: "Transfer to High-Yield Savings",
            category: null,
          };
        } else if (brokerage && kind < 0.08) {
          row = brokerageActivity();
        } else {
          const spending = pick(SPENDING);
          const account = pick([ACCOUNTS[0], ACCOUNTS[1], ACCOUNTS[1], ACCOUNTS[3], ACCOUNTS[4]]);
          const scale = account.currency === "INR" ? 80 : 1;
          row = {
            account,
            currency: account.currency,
            value: -between(spending.range[0], spending.range[1]) * scale,
            counterparty: pick(spending.counterparties),
            // A few left for the user to categorise.
            category: rand() < 0.03 ? null : spending.name,
          };
        }

        const id = crypto.randomUUID();
        insert
          .bind([
            seq,
            id,
            source,
            row.account.name,
            row.transfer ?? null,
            ...amount(row.value, row.currency),
            row.currency,
            row.counterparty,
            row.category,
            date,
            rand() < 0.05 ? pick(REMARKS) : null,
          ])
          .stepReset();
        if (row.account.currency === "EUR")
          insertConversion.bind([id, "USD", ...amount(row.value * 1.09, "USD")]).stepReset();
      }
    } finally {
      insert.finalize();
      insertConversion.finalize();
      insertSource.finalize();
    }
  });

  /** A trade, dividend, fee or deposit in the brokerage account. */
  function brokerageActivity() {
    const { currency, perDollar, tickers } = pick(MARKETS);
    const ticker = pick(tickers);
    const activity = rand();
    const inCurrency = (dollars: number) => ({ currency, value: dollars * perDollar });
    if (activity < 0.05)
      return {
        account: BROKERAGE,
        currency: "USD",
        transfer: ACCOUNTS[0].name,
        value: between(500, 5000),
        counterparty: "Transfer from Everyday Checking",
        category: null,
      };
    if (activity < 0.4)
      return {
        account: BROKERAGE,
        ...inCurrency(-between(200, 5000)),
        counterparty: `Buy ${ticker}`,
        category: "Trades",
      };
    if (activity < 0.65)
      return {
        account: BROKERAGE,
        ...inCurrency(between(200, 5000)),
        counterparty: `Sell ${ticker}`,
        category: "Trades",
      };
    if (activity < 0.9)
      return {
        account: BROKERAGE,
        ...inCurrency(between(5, 150)),
        counterparty: `${ticker} dividend`,
        category: "Dividends",
      };
    return {
      account: BROKERAGE,
      ...inCurrency(-between(1, 15)),
      counterparty: pick(["Commission", "FX conversion fee", "Custody fee"]),
      category: "Fees",
    };
  }
}
