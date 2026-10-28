import type { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadDatabase } from "../api/database.ts";
import { deriveKek } from "../lib/kek.ts";
import { EXPORT_KEY, SOURCE_HASH, TOKEN, transactionId } from "../test/fixtures.ts";
import { openDatabase, type Database } from "./database.ts";
import type { DatabaseHistory } from "./databaseContext.ts";
import { EditHistory } from "./editHistory.ts";
import { compareNewestFirst, newestFirst } from "./queries/transactions.ts";
import { createQueryClient } from "./queryClient.ts";
import {
  addTransaction,
  existing,
  keepTransactionsInSync,
  transactionsQuery,
  type NewTransaction,
  type Placement,
} from "./transactions.ts";

vi.mock("../api/database.ts", () => ({
  downloadDatabase: vi.fn(),
  downloadDatabaseIfChanged: vi.fn(),
  uploadDatabase: vi.fn(),
}));

/** The day the transactions are on. */
const DAY = "2026-10-05";
/** The day they're added on. */
const TODAY = "2026-10-28";
/** A time on `DAY` (`HH:MM`, UTC), as a timestamp. */
const at = (time: string) => Date.parse(`${DAY}T${time}Z`) / 1000;

let database: Database;
let history: DatabaseHistory;
let queryClient: QueryClient;
let stopSyncing: () => void;
let count = 0;

beforeEach(async () => {
  vi.mocked(downloadDatabase).mockResolvedValue({ success: false, code: "NOT_FOUND" });
  database = await openDatabase({
    username: "alice",
    token: TOKEN,
    kek: await deriveKek(EXPORT_KEY),
  });
  count = 0;
  await database.batch([
    { sql: "INSERT INTO accounts VALUES ('Checking', 'USD', 'Bank', NULL)" },
    { sql: "INSERT INTO sources (hash, remarks) VALUES (?, 'statement.csv')", bind: [SOURCE_HASH] },
  ]);
  queryClient = createQueryClient();
  history = new EditHistory(database);
  stopSyncing = keepTransactionsInSync(queryClient, database, history);
});
afterEach(() => {
  stopSyncing();
  database.close();
});

/**
 * Stores transactions on `DAY` named `counterparties`, oldest first,
 * numbered from 1, at `timestamp` if given, then reads them for the page.
 */
async function stored(counterparties: string[], timestamp: number | null = null) {
  await database.batch(
    counterparties.map((counterparty, index) => {
      count++;
      return {
        sql: `INSERT INTO transactions (id, source, account_name, currency, amount, counterparty,
          naive_date, timestamp, sort_key)
          VALUES (?, ?, 'Checking', 'USD', -100, ?, ?, ?, ?)`,
        bind: [transactionId(count), SOURCE_HASH, counterparty, DAY, timestamp, index + 1],
      };
    }),
  );
  await queryClient.fetchQuery({ ...transactionsQuery(database), staleTime: 0 });
}

const cached = () => queryClient.getQueryData(transactionsQuery(database).queryKey)!;
const idOf = (counterparty: string) =>
  cached().rows.find((row) => row?.counterparty === counterparty)!.id;

/** `DAY`'s transactions as stored, newest first, with their sort keys. */
async function day() {
  const rows = await database.query(
    `SELECT counterparty, sort_key FROM transactions WHERE naive_date = ?
    ORDER BY ${newestFirst("transactions")}`,
    [DAY],
  );
  return rows.map(({ counterparty, sort_key }) => `${String(counterparty)} ${String(sort_key)}`);
}

/** `DAY`'s transactions in the page's copy, as `day` gives them. */
function cachedDay() {
  return existing(cached())
    .filter((row) => row.naive_date === DAY)
    .toSorted(compareNewestFirst)
    .map((row) => `${row.counterparty} ${row.sort_key}`);
}

/** `bytes` as SQLite's hex() gives them. */
const hex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join("");

function add(placement: Placement, transaction: Partial<NewTransaction> = {}) {
  return addTransaction(queryClient, database, history, {
    transaction: {
      naive_date: DAY,
      timestamp: null,
      account_name: "Checking",
      currency: "USD",
      amount: 0,
      counterparty: "New",
      remarks: null,
      ...transaction,
    },
    placement,
    description: "adding a transaction",
    today: TODAY,
  });
}

describe("addTransaction", () => {
  it.each([
    ["newer", ["C 4", "New 3", "B 2", "A 1"]],
    ["older", ["C 4", "B 3", "New 2", "A 1"]],
  ] as const)(
    "adds one beside another, on its %s side, numbering the day again",
    async (side, expected) => {
      await stored(["A", "B", "C"]);

      await add({ kind: "beside", id: idOf("B"), side });

      expect(await day()).toEqual(expected);
      expect(cachedDay()).toEqual(expected);
    },
  );

  it("writes only the numbers that change", async () => {
    await stored(["A", "B", "C"]);
    const batch = vi.spyOn(database, "batch");

    await add({ kind: "beside", id: idOf("C"), side: "newer" });

    const updates = batch.mock.calls[0]![0].filter(({ sql }) => sql.includes("SET sort_key"));
    expect(updates).toEqual([]);
  });

  it("adds one beside a timed one at its time", async () => {
    await stored(["Untimed"]);
    await stored(["Morning"], at("09:00"));

    await add({ kind: "beside", id: idOf("Morning"), side: "newer" }, { timestamp: at("09:00") });

    expect(await day()).toEqual(["New 3", "Morning 2", "Untimed 1"]);
  });

  it("refuses to add one beside another at another time, changing nothing", async () => {
    await stored(["Morning"], at("09:00"));

    await expect(add({ kind: "beside", id: idOf("Morning"), side: "newer" })).rejects.toThrow(
      "A transaction can only be added beside one on its day, at its time",
    );

    expect(await day()).toEqual(["Morning 1"]);
    expect(cached().rows).toHaveLength(1);
    expect(history.canUndo).toBe(false);
  });

  it("adds the newest of those without a time, below those with one", async () => {
    await stored(["Older", "Newer"]);
    await stored(["Evening"], at("18:00"));

    await add({ kind: "newest" });

    expect(await day()).toEqual(["Evening 4", "New 3", "Newer 2", "Older 1"]);
  });

  it("adds the first of its day", async () => {
    await stored([]);

    await add({ kind: "newest" });

    expect(await day()).toEqual(["New 1"]);
  });

  it("stores what it was given, with no category, transfer or duplicate", async () => {
    await stored([]);

    const id = await add(
      { kind: "newest" },
      { counterparty: "-", amount: 0, remarks: null, timestamp: at("10:00") },
    );

    expect(
      await database.query(
        `SELECT id, account_name, currency, amount, counterparty, category, transfer_account,
          duplicate_of, naive_date, timestamp, remarks FROM transactions`,
      ),
    ).toEqual([
      {
        id,
        account_name: "Checking",
        currency: "USD",
        amount: 0,
        counterparty: "-",
        category: null,
        transfer_account: null,
        duplicate_of: null,
        naive_date: DAY,
        timestamp: at("10:00"),
        remarks: null,
      },
    ]);
    expect(cached().rows[0]).toMatchObject({ id, decimals: 2, conversions: {} });
  });

  it("makes the day's source with its first, named for the day and hashed from its name", async () => {
    await stored([]);
    const name = `Spendy2 Web UI - ${TODAY}`;
    const hash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name)),
    );

    await add({ kind: "newest" });
    await add({ kind: "newest" });

    expect(
      await database.query(
        `SELECT remarks, hex(hash) AS hash,
          (SELECT count(*) FROM transactions WHERE source = hash) AS transactions
        FROM sources WHERE remarks <> 'statement.csv'`,
      ),
    ).toEqual([{ remarks: name, hash: hex(hash), transactions: 2 }]);
  });

  it("is in the page's copy, and to undo, as soon as it's asked to be written", async () => {
    await stored(["A"]);
    let write!: () => void;
    const writing = new Promise<void>((resolve) => (write = resolve));
    const batch = database.batch.bind(database);
    vi.spyOn(database, "batch").mockImplementationOnce(async (statements) => {
      await writing;
      return batch(statements);
    });

    const adding = add({ kind: "newest" });
    await expect.poll(() => cachedDay()).toEqual(["New 2", "A 1"]);
    expect(history.canUndo).toBe(true);
    write();

    expect(await adding).toBe(idOf("New"));
  });

  it("numbers the day with adds still being written", async () => {
    await stored(["A"]);

    await Promise.all([
      add({ kind: "newest" }, { counterparty: "X" }),
      add({ kind: "newest" }, { counterparty: "Y" }),
    ]);

    const keys = (await day()).map((row) => row.split(" ")[1]);
    expect(keys).toEqual(["3", "2", "1"]);
    expect(cachedDay()).toEqual(await day());
  });

  it("takes it out again when it can't be written, and says why", async () => {
    await stored(["A", "B"]);
    vi.spyOn(database, "batch").mockRejectedValueOnce(new Error("disk on fire"));

    await expect(add({ kind: "beside", id: idOf("A"), side: "newer" })).rejects.toThrow(
      "disk on fire",
    );

    expect(cached().removed).toEqual(new Set([cached().rows.length - 1]));
    expect(cachedDay()).toEqual(["B 2", "A 1"]);
    expect(history.canUndo).toBe(false);
  });

  describe("undone and redone", () => {
    it("is taken out on undo, its place and data kept, and put back there on redo", async () => {
      await stored(["A", "B"]);
      const id = await add({ kind: "beside", id: idOf("A"), side: "newer" });
      const position = cached().positions.get(id!)!;

      await history.undo();
      await expect.poll(() => cached().removed).toEqual(new Set([position]));
      expect(cached().rows[position]!.id).toBe(id);
      expect(await day()).toEqual(["B 2", "A 1"]);
      expect(cachedDay()).toEqual(["B 2", "A 1"]);
      await history.redo();

      await expect.poll(() => cached().removed).toEqual(new Set());
      expect(cached().rows[position]!.id).toBe(id);
      expect(await day()).toEqual(["B 3", "New 2", "A 1"]);
      expect(cachedDay()).toEqual(["B 3", "New 2", "A 1"]);
    });

    it("is put back after the rest when redone after they were read again", async () => {
      await stored(["A"]);
      const id = await add({ kind: "newest" });
      await history.undo();
      await expect.poll(() => cachedDay()).toEqual(["A 1"]);
      await queryClient.refetchQueries({ queryKey: transactionsQuery(database).queryKey });
      expect(cached().positions.has(id!)).toBe(false);

      await history.redo();

      await expect.poll(() => cached().rows.at(-1)?.id).toBe(id);
      expect(cached().positions.get(id!)).toBe(cached().rows.length - 1);
      expect(cachedDay()).toEqual(["New 2", "A 1"]);
    });

    it("is the latest undo or redo in the page's copy, once its rows show it", async () => {
      await stored(["A"]);
      const id = await add({ kind: "newest" });
      const position = cached().positions.get(id!)!;

      const undone = await history.undo();

      await expect.poll(() => cached().lastUndoOrRedo).toBe(undone);
      expect(cached().removed.has(position)).toBe(true);
    });

    it("selects every cell of it when redone", async () => {
      await stored([]);
      const id = await add({ kind: "newest" });
      await history.undo();

      const redone = await history.redo();

      expect(redone?.step.about.cells.map(({ field }) => field).sort()).toEqual([
        "account_name",
        "amount",
        "category",
        "counterparty",
        "naive_date",
        "remarks",
      ]);
      expect(new Set(redone?.step.about.cells.map((cell) => cell.id))).toEqual(new Set([id]));
    });
  });
});
