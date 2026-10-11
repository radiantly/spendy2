/**
 * Generated test data: a few accounts and categories, and transactions spread
 * over ten years. Deterministic apart from the transaction ids.
 */
import type { Database } from "@sqlite.org/sqlite-wasm";
import { AMOUNT_SCALE } from "../src/db/queries/transactions.ts";

const ACCOUNTS = [
  { name: "Everyday Checking", currency: "USD" },
  { name: "Rewards Credit Card", currency: "USD" },
  { name: "High-Yield Savings", currency: "USD" },
  { name: "Travel Card", currency: "EUR" },
  { name: "India Savings", currency: "INR" },
];

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

/** Fills a migrated, empty database with `count` realistic transactions. */
export function generateTestData(db: Database, count: number) {
  const rand = random(42);
  const pick = <T>(items: readonly T[]) => items[Math.floor(rand() * items.length)]!;
  const between = (min: number, max: number) => min + rand() * (max - min);
  const amount = (value: number) => Math.round(value * AMOUNT_SCALE);

  db.transaction(() => {
    for (const account of ACCOUNTS)
      db.exec({
        sql: "INSERT INTO accounts VALUES (?, ?)",
        bind: [account.name, account.currency],
      });

    const parents = [...new Set([...SPENDING.map((c) => c.parent), "Income"])];
    for (const parent of parents)
      db.exec({ sql: "INSERT INTO categories VALUES (?, NULL)", bind: [parent] });
    for (const { parent, name } of SPENDING)
      db.exec({ sql: "INSERT INTO categories VALUES (?, ?)", bind: [name, parent] });
    for (const name of ["Rent", "Salary", "Interest"])
      db.exec({
        sql: "INSERT INTO categories VALUES (?, ?)",
        bind: [name, name === "Rent" ? "Housing" : "Income"],
      });

    const insert = db.prepare(`
      INSERT INTO transactions (seq, id, source, account_name, transfer_account, amount, currency,
        converted_amount, converted_currency, counterparty, category, naive_date, remarks)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertSource = db.prepare("INSERT OR IGNORE INTO sources (hash, remarks) VALUES (?, ?)");

    // Spread over the past ten years, oldest first, so seq follows the dates.
    const end = Date.UTC(2026, 9, 10);
    const start = end - 10 * 365 * 86_400_000;
    try {
      for (let seq = 1; seq <= count; seq++) {
        const date = new Date(start + ((end - start) * seq) / count).toISOString().slice(0, 10);
        const source = `import-${date.slice(0, 7)}`;
        insertSource.bind([source, `statement ${date.slice(0, 7)}.csv`]).stepReset();

        const kind = rand();
        let row: {
          account: (typeof ACCOUNTS)[number];
          transfer?: string;
          value: number;
          counterparty: string;
          category: string | null;
        };
        if (kind < 0.02) {
          row = {
            account: ACCOUNTS[0]!,
            value: between(2000, 4000),
            counterparty: "Acme Corp Payroll",
            category: "Salary",
          };
        } else if (kind < 0.03) {
          row = {
            account: ACCOUNTS[0]!,
            value: -between(1200, 1400),
            counterparty: "Parkside Apartments",
            category: "Rent",
          };
        } else if (kind < 0.05) {
          row = {
            account: ACCOUNTS[0]!,
            transfer: ACCOUNTS[2]!.name,
            value: -between(100, 500),
            counterparty: "Transfer to High-Yield Savings",
            category: null,
          };
        } else {
          const spending = pick(SPENDING);
          const account = pick([
            ACCOUNTS[0]!,
            ACCOUNTS[1]!,
            ACCOUNTS[1]!,
            ACCOUNTS[3]!,
            ACCOUNTS[4]!,
          ]);
          const scale = account.currency === "INR" ? 80 : 1;
          row = {
            account,
            value: -between(spending.range[0], spending.range[1]) * scale,
            counterparty: pick(spending.counterparties),
            // A few left for the user to categorise.
            category: rand() < 0.03 ? null : spending.name,
          };
        }

        const converted = row.account.currency === "EUR" ? amount(row.value * 1.09) : null;
        insert
          .bind([
            seq,
            crypto.randomUUID(),
            source,
            row.account.name,
            row.transfer ?? null,
            amount(row.value),
            row.account.currency,
            converted,
            converted === null ? null : "USD",
            row.counterparty,
            row.category,
            date,
            rand() < 0.05 ? pick(REMARKS) : null,
          ])
          .stepReset();
      }
    } finally {
      insert.finalize();
      insertSource.finalize();
    }
  });
}
