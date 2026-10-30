import { afterEach, describe, expect, it } from "vitest";
import { connect, RemoteError, type Remote } from "./rpc.ts";
import type { DatabaseApi } from "./worker.ts";
import { MIGRATIONS } from "./migrations.ts";
import { deriveKek } from "../lib/kek.ts";
import { EXPORT_KEY } from "../test/fixtures.ts";
import { openSqliteFile } from "../test/sqliteFile.ts";

const workers: Worker[] = [];
afterEach(() => {
  for (const worker of workers.splice(0)) worker.terminate();
});

function startWorker(): Remote<DatabaseApi> {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  workers.push(worker);
  return connect<DatabaseApi>(worker).remote;
}

async function rejection(promise: Promise<unknown>) {
  return promise.then(
    () => expect.unreachable("expected a rejection"),
    (error: unknown) => error,
  );
}

describe("database worker", () => {
  it("creates a migrated database when there is no blob", async () => {
    const db = startWorker();

    expect(await db.open(null, await deriveKek(EXPORT_KEY))).toEqual({ created: true });

    expect(await db.query("PRAGMA user_version")).toEqual([{ user_version: MIGRATIONS.length }]);
    expect(await db.query("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
    expect(await db.query("PRAGMA recursive_triggers")).toEqual([{ recursive_triggers: 1 }]);
  });

  it("reopens an exported database with its data", async () => {
    const kek = await deriveKek(EXPORT_KEY);
    const first = startWorker();
    await first.open(null, kek);
    await first.query("INSERT INTO accounts VALUES (?, ?, 'Bank', NULL)", ["checking", "SGD"]);

    const blob = await first.export();
    const second = startWorker();

    expect(await second.open(blob, kek)).toEqual({ created: false });
    expect(await second.query("SELECT * FROM accounts")).toEqual([
      { name: "checking", display_currency: "SGD", type: "Bank", identifier: null },
    ]);
    expect(await second.query("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
  });

  it("keeps the database usable after an export", async () => {
    const db = startWorker();
    await db.open(null, await deriveKek(EXPORT_KEY));
    await db.export();

    await db.query("INSERT INTO accounts VALUES ('checking', 'SGD', 'Bank', NULL)");

    expect(await db.query("SELECT count(*) AS n FROM accounts")).toEqual([{ n: 1 }]);
  });

  it("rejects queries before a database is open", async () => {
    const error = await rejection(startWorker().query("SELECT 1"));

    expect(error).toBeInstanceOf(RemoteError);
    expect((error as RemoteError).message).toBe("The database isn't open");
  });

  it("reports a blob it can't decrypt with the blob error code", async () => {
    const first = startWorker();
    await first.open(null, await deriveKek(EXPORT_KEY));
    const blob = await first.export();

    const error = await rejection(
      startWorker().open(blob, await deriveKek("b3RoZXIgZXhwb3J0IGtleQ")),
    );

    expect(error).toMatchObject({ name: "DatabaseBlobError", code: "DECRYPTION_FAILED" });
  });

  it("keeps the open database when opening another one fails", async () => {
    const kek = await deriveKek(EXPORT_KEY);
    const db = startWorker();
    await db.open(null, kek);
    await db.query("INSERT INTO accounts VALUES ('checking', 'SGD', 'Bank', NULL)");

    await rejection(db.open(new Uint8Array([1, 2, 3]), kek));

    expect(await db.query("SELECT name FROM accounts")).toEqual([{ name: "checking" }]);
  });

  it("reports SQL errors with sqlite's message", async () => {
    const db = startWorker();
    await db.open(null, await deriveKek(EXPORT_KEY));

    const error = await rejection(db.query("SELECT * FROM missing"));

    expect((error as Error).message).toContain("no such table: missing");
  });

  it("runs a batch in one transaction", async () => {
    const db = startWorker();
    await db.open(null, await deriveKek(EXPORT_KEY));

    await db.batch([
      { sql: "INSERT INTO accounts VALUES (?, ?, 'Bank', NULL)", bind: ["checking", "USD"] },
      { sql: "INSERT INTO accounts VALUES (?, ?, 'Bank', NULL)", bind: ["savings", "USD"] },
    ]);

    expect(await db.query("SELECT name FROM accounts ORDER BY name")).toEqual([
      { name: "checking" },
      { name: "savings" },
    ]);
  });

  it("rolls back the whole batch when a statement fails", async () => {
    const db = startWorker();
    await db.open(null, await deriveKek(EXPORT_KEY));

    const error = await rejection(
      db.batch([
        { sql: "INSERT INTO accounts VALUES (?, ?, 'Bank', NULL)", bind: ["checking", "USD"] },
        { sql: "INSERT INTO accounts VALUES (?, ?, 'Bank', NULL)", bind: ["checking", "EUR"] },
      ]),
    );

    expect((error as Error).message).toContain("UNIQUE constraint failed");
    expect(await db.query("SELECT name FROM accounts")).toEqual([]);
  });
});

describe("database worker changes", () => {
  const INSERT_CHECKING = { sql: "INSERT INTO accounts VALUES ('checking', 'USD', 'Bank', NULL)" };
  const INSERT_SAVINGS = { sql: "INSERT INTO accounts VALUES ('savings', 'USD', 'Bank', NULL)" };
  const accounts = async (db: Remote<DatabaseApi>) =>
    (await db.query("SELECT name FROM accounts ORDER BY name")).map(({ name }) => name);

  async function opened() {
    const db = startWorker();
    await db.open(null, await deriveKek(EXPORT_KEY));
    return db;
  }

  it("has nothing unsaved when opened", async () => {
    expect(await (await opened()).status()).toEqual({ unsaved: false });
  });

  it("returns a batch's changes, and that they're unsaved", async () => {
    const db = await opened();

    const { changes, unsaved } = await db.batch([INSERT_CHECKING]);

    expect(changes.length).toBeGreaterThan(0);
    expect(unsaved).toBe(true);
  });

  it("undoes and redoes a batch", async () => {
    const db = await opened();
    await db.batch([INSERT_CHECKING]);
    const { changes } = await db.batch([INSERT_SAVINGS]);

    expect(await db.undo(changes)).toEqual({ unsaved: true });
    expect(await accounts(db)).toEqual(["checking"]);
    expect(await db.redo(changes)).toEqual({ unsaved: true });
    expect(await accounts(db)).toEqual(["checking", "savings"]);
  });

  it("has nothing unsaved once undone back to what was opened", async () => {
    const db = await opened();
    const { changes } = await db.batch([INSERT_CHECKING]);

    expect(await db.undo(changes)).toEqual({ unsaved: false });
  });

  it("rejects an undo that doesn't fit, changing nothing", async () => {
    const db = await opened();
    const { changes } = await db.batch([INSERT_CHECKING]);
    await db.undo(changes);

    const error = await rejection(db.undo(changes));

    expect((error as Error).message).toContain("The changes don't match the database");
    expect(await accounts(db)).toEqual([]);
  });

  it("counts unsaved changes from the version saved", async () => {
    const db = await opened();
    const { changes } = await db.batch([INSERT_CHECKING]);
    await db.export();

    expect(await db.finishSave(true)).toEqual({ unsaved: false });
    expect(await db.undo(changes)).toEqual({ unsaved: true });
    expect(await db.redo(changes)).toEqual({ unsaved: false });
  });

  it("keeps changes made during a save unsaved", async () => {
    const db = await opened();
    await db.batch([INSERT_CHECKING]);
    await db.export();
    await db.batch([INSERT_SAVINGS]);

    expect(await db.finishSave(true)).toEqual({ unsaved: true });
  });

  it("counts from the version last saved when a save fails", async () => {
    const db = await opened();
    const { changes } = await db.batch([INSERT_CHECKING]);
    await db.export();

    expect(await db.finishSave(false)).toEqual({ unsaved: true });
    expect(await db.undo(changes)).toEqual({ unsaved: false });
  });

  it("forgets an export that couldn't be encrypted", async () => {
    const db = startWorker();
    // Can't wrap the data key, so encrypting fails.
    const kek = await crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, false, [
      "unwrapKey",
    ]);
    await db.open(null, kek);
    await db.batch([INSERT_CHECKING]);

    await rejection(db.export());

    // Had the export's version stayed, this would count it as saved.
    expect(await db.finishSave(true)).toEqual({ unsaved: true });
  });

  it("serializes the database as an SQLite file, unsaved changes too, still unsaved", async () => {
    const db = await opened();
    await db.batch([INSERT_CHECKING]);

    const copy = await openSqliteFile(await db.serialize());

    expect(copy.selectValues("SELECT name FROM accounts")).toEqual(["checking"]);
    copy.close();
    expect(await db.status()).toEqual({ unsaved: true });
  });

  it("leaves nothing unsaved after a batch that failed", async () => {
    const db = await opened();

    await rejection(db.batch([INSERT_CHECKING, INSERT_CHECKING]));

    expect(await db.status()).toEqual({ unsaved: false });
  });
});
