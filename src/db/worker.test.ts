import { afterEach, describe, expect, it } from "vitest";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { NO_PREVIOUS_PART, readParts, sha256Hex } from "../../workers/spendy2/databaseParts.ts";
import { connect, RemoteError, type Remote } from "./rpc.ts";
import type { DatabaseApi } from "./worker.ts";
import { MIGRATIONS } from "./migrations.ts";
import { decryptPart, encryptPart } from "./parts.ts";
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

const kek = () => deriveKek(EXPORT_KEY);

/** `parts`, one after the other, as they're downloaded. */
function concat(parts: Uint8Array<ArrayBuffer>[]) {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

/** Saves `db` as if the upload worked, and returns the part uploaded. */
async function save(db: Remote<DatabaseApi>) {
  const prepared = await db.prepareSave();
  if (prepared === null) expect.unreachable("expected something to save");
  await db.finishSave(true);
  return prepared.part;
}

/** A worker with `parts` open. */
async function openedFrom(parts: Uint8Array<ArrayBuffer>[]) {
  const db = startWorker();
  await db.open(concat(parts), await kek());
  return db;
}

/** The part `bytes` are, as `readParts` reads it. */
async function partOf(bytes: Uint8Array<ArrayBuffer>) {
  const read = await readParts(bytes);
  if (!read.success) expect.unreachable(read.code);
  return read.parts[0]!;
}

const INSERT_CHECKING = { sql: "INSERT INTO accounts VALUES ('checking', 'USD', 'Bank', NULL)" };
const INSERT_SAVINGS = { sql: "INSERT INTO accounts VALUES ('savings', 'USD', 'Bank', NULL)" };
const INSERT_BROKERAGE = {
  sql: "INSERT INTO accounts VALUES ('brokerage', 'USD', 'Broker', NULL)",
};
const accounts = async (db: Remote<DatabaseApi>) =>
  (await db.query("SELECT name FROM accounts ORDER BY name")).map(({ name }) => name);

describe("database worker", () => {
  it("creates a migrated database when there are no parts", async () => {
    const db = startWorker();

    expect(await db.open(null, await kek())).toEqual({ created: true, hashes: [] });

    expect(await db.query("PRAGMA user_version")).toEqual([{ user_version: MIGRATIONS.length }]);
    expect(await db.query("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
    expect(await db.query("PRAGMA recursive_triggers")).toEqual([{ recursive_triggers: 1 }]);
  });

  it("reopens a saved database with its data, and its part's hash", async () => {
    const first = startWorker();
    await first.open(null, await kek());
    await first.query("INSERT INTO accounts VALUES (?, ?, 'Bank', NULL)", ["checking", "SGD"]);
    const part = await save(first);
    const sha256 = await sha256Hex(part);

    const second = startWorker();

    expect(await second.open(part, await kek())).toEqual({ created: false, hashes: [sha256] });
    expect(await second.query("SELECT * FROM accounts")).toEqual([
      { name: "checking", display_currency: "SGD", type: "Bank", identifier: null },
    ]);
    expect(await second.query("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
  });

  it("keeps the database usable after a save", async () => {
    const db = startWorker();
    await db.open(null, await kek());
    await save(db);

    await db.query("INSERT INTO accounts VALUES ('checking', 'SGD', 'Bank', NULL)");

    expect(await db.query("SELECT count(*) AS n FROM accounts")).toEqual([{ n: 1 }]);
  });

  it("rejects queries before a database is open", async () => {
    const error = await rejection(startWorker().query("SELECT 1"));

    expect(error).toBeInstanceOf(RemoteError);
    expect((error as RemoteError).message).toBe("The database isn't open");
  });

  it("reports parts it can't decrypt with the part error code", async () => {
    const first = startWorker();
    await first.open(null, await kek());
    const part = await save(first);

    const error = await rejection(
      startWorker().open(part, await deriveKek("b3RoZXIgZXhwb3J0IGtleQ")),
    );

    expect(error).toMatchObject({ name: "DatabasePartError", code: "DECRYPTION_FAILED" });
  });

  it("reports parts that don't chain with the part error code", async () => {
    const first = startWorker();
    await first.open(null, await kek());
    const part0 = await save(first);
    await first.batch([INSERT_CHECKING]);
    const part1 = await save(first);

    const error = await rejection(startWorker().open(concat([part1, part0]), await kek()));

    expect(error).toMatchObject({ name: "DatabasePartError", code: "BROKEN_CHAIN" });
  });

  it("keeps the open database when opening another one fails", async () => {
    const db = startWorker();
    await db.open(null, await kek());
    await db.query("INSERT INTO accounts VALUES ('checking', 'SGD', 'Bank', NULL)");

    await rejection(db.open(new Uint8Array([1, 2, 3]), await kek()));

    expect(await db.query("SELECT name FROM accounts")).toEqual([{ name: "checking" }]);
  });

  it("reports SQL errors with sqlite's message", async () => {
    const db = startWorker();
    await db.open(null, await kek());

    const error = await rejection(db.query("SELECT * FROM missing"));

    expect((error as Error).message).toContain("no such table: missing");
  });

  it("runs a batch in one transaction", async () => {
    const db = startWorker();
    await db.open(null, await kek());

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
    await db.open(null, await kek());

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

describe("database worker saves", () => {
  async function opened() {
    const db = startWorker();
    await db.open(null, await kek());
    return db;
  }

  it("saves the whole database first, as part 0", async () => {
    const db = await opened();
    await db.batch([INSERT_CHECKING]);

    const prepared = await db.prepareSave();

    expect(prepared?.previous).toBeNull();
    const part = await partOf(prepared!.part);
    expect(part).toMatchObject({ previousHash: NO_PREVIOUS_PART, userVersion: MIGRATIONS.length });
    const file = await openSqliteFile(await decryptPart(part, await kek()));
    expect(file.selectValues("SELECT name FROM accounts")).toEqual(["checking"]);
    file.close();
  });

  it("saves only the changes after that, following the part saved", async () => {
    const db = await opened();
    await db.batch([INSERT_CHECKING]);
    const part0 = await save(db);
    await db.batch([INSERT_SAVINGS]);

    const prepared = await db.prepareSave();

    const previous = await sha256Hex(part0);
    expect(prepared?.previous).toBe(previous);
    const part = await partOf(prepared!.part);
    expect(part).toMatchObject({ previousHash: previous, userVersion: MIGRATIONS.length });
    // A changeset, far smaller than the SQLite file: its pages alone take kilobytes.
    expect((await decryptPart(part, await kek())).length).toBeLessThan(200);
  });

  it("returns the hash of the part saved, once a save is done", async () => {
    const db = await opened();
    const first = await db.prepareSave();

    expect(await db.finishSave(true)).toEqual({
      unsaved: false,
      sha256: await sha256Hex(first!.part),
    });
    await db.batch([INSERT_CHECKING]);
    const second = await db.prepareSave();
    expect(await db.finishSave(true)).toEqual({
      unsaved: false,
      sha256: await sha256Hex(second!.part),
    });
  });

  it("opens the parts saved one after another as the database they make up", async () => {
    const db = await opened();
    await db.batch([INSERT_CHECKING]);
    const parts = [await save(db)];
    await db.batch([INSERT_SAVINGS]);
    parts.push(await save(db));
    await db.batch([{ sql: "DELETE FROM accounts WHERE name = 'checking'" }, INSERT_BROKERAGE]);
    parts.push(await save(db));

    const reopened = startWorker();

    expect(await reopened.open(concat(parts), await kek())).toEqual({
      created: false,
      hashes: await Promise.all(parts.map((part) => sha256Hex(part))),
    });
    expect(await accounts(reopened)).toEqual(["brokerage", "savings"]);
  });

  it("has nothing to save when nothing changed since the version saved", async () => {
    const db = await opened();
    const { changes } = await db.batch([INSERT_CHECKING]);
    await save(db);
    await db.undo(changes);
    await db.redo(changes);

    expect(await db.prepareSave()).toBeNull();
  });

  it("saves a database never saved even when nothing changed", async () => {
    const db = await opened();

    expect(await db.prepareSave()).toMatchObject({ previous: null });
  });

  it("migrates part 0 to each changeset's version before applying it", async () => {
    // An SQLite file before the first migration: no tables at all.
    const sqlite3 = await sqlite3InitModule();
    const empty = new sqlite3.oo1.DB(":memory:");
    empty.exec("PRAGMA user_version = 0; PRAGMA application_id = 1");
    const part0 = await encryptPart(sqlite3.capi.sqlite3_js_db_export(empty), await kek(), {
      previousHash: NO_PREVIOUS_PART,
      userVersion: 0,
    });
    empty.close();
    // Recorded on a database with the accounts table the first migration makes.
    const recorder = await opened();
    const { changes } = await recorder.batch([INSERT_CHECKING]);
    const part1 = await encryptPart(new Uint8Array(changes), await kek(), {
      previousHash: await sha256Hex(part0),
      userVersion: 1,
    });

    const db = await openedFrom([part0, part1]);

    expect(await accounts(db)).toEqual(["checking"]);
  });

  it("refuses a changeset saved by a newer version of the app", async () => {
    const db = await opened();
    const part0 = await save(db);
    const newer = await encryptPart(new Uint8Array(), await kek(), {
      previousHash: await sha256Hex(part0),
      userVersion: MIGRATIONS.length + 1,
    });

    const error = await rejection(startWorker().open(concat([part0, newer]), await kek()));

    expect(error).toMatchObject({ name: "DatabaseTooNewError" });
  });
});

describe("database worker rebases", () => {
  /** Two copies of a stored database holding checking, and its part. */
  async function twoCopies() {
    const creator = startWorker();
    await creator.open(null, await kek());
    await creator.batch([INSERT_CHECKING]);
    const part0 = await save(creator);
    return { part0, here: await openedFrom([part0]), elsewhere: await openedFrom([part0]) };
  }

  it("moves unsaved changes onto a newer version, to save after it", async () => {
    const { part0, here, elsewhere } = await twoCopies();
    await elsewhere.batch([INSERT_SAVINGS]);
    const part1 = await save(elsewhere);
    await here.batch([INSERT_BROKERAGE]);

    expect(await here.rebase(concat([part0, part1]))).toEqual({
      outcome: "moved",
      unsaved: true,
      hashes: [await sha256Hex(part0), await sha256Hex(part1)],
    });
    expect(await accounts(here)).toEqual(["brokerage", "checking", "savings"]);

    const prepared = await here.prepareSave();
    expect(prepared?.previous).toBe(await sha256Hex(part1));
    await here.finishSave(true);
    expect(await accounts(await openedFrom([part0, part1, prepared!.part]))).toEqual([
      "brokerage",
      "checking",
      "savings",
    ]);
  });

  it("counts only its own changes as unsaved", async () => {
    const { part0, here, elsewhere } = await twoCopies();
    await elsewhere.batch([INSERT_SAVINGS]);
    const part1 = await save(elsewhere);

    expect(await here.rebase(concat([part0, part1]))).toMatchObject({
      outcome: "moved",
      unsaved: false,
    });
  });

  it("changes nothing when its changes conflict with the newer version's", async () => {
    const { part0, here, elsewhere } = await twoCopies();
    await elsewhere.batch([{ sql: "UPDATE accounts SET type = 'Card' WHERE name = 'checking'" }]);
    const part1 = await save(elsewhere);
    await here.batch([{ sql: "UPDATE accounts SET type = 'Cash' WHERE name = 'checking'" }]);

    expect(await here.rebase(concat([part0, part1]))).toEqual({
      outcome: "conflict",
      unsaved: true,
    });

    expect(await here.query("SELECT type FROM accounts")).toEqual([{ type: "Cash" }]);
    expect((await here.prepareSave())?.previous).toBe(await sha256Hex(part0));
  });

  it("keeps edits made before it undoable, where the newer version didn't change them", async () => {
    const { part0, here, elsewhere } = await twoCopies();
    await elsewhere.batch([INSERT_SAVINGS]);
    const part1 = await save(elsewhere);
    const { changes } = await here.batch([INSERT_BROKERAGE]);
    await here.rebase(concat([part0, part1]));

    expect(await here.undo(changes)).toEqual({ unsaved: false });
    expect(await accounts(here)).toEqual(["checking", "savings"]);
  });
});

describe("database worker catch-ups", () => {
  /** Two copies of a stored database holding checking, and its part. */
  async function twoCopies() {
    const creator = startWorker();
    await creator.open(null, await kek());
    await creator.batch([INSERT_CHECKING]);
    const part0 = await save(creator);
    return { part0, here: await openedFrom([part0]), elsewhere: await openedFrom([part0]) };
  }

  it("moves unsaved changes onto the parts saved after its own, to save after them", async () => {
    const { part0, here, elsewhere } = await twoCopies();
    await elsewhere.batch([INSERT_SAVINGS]);
    const part1 = await save(elsewhere);
    await here.batch([INSERT_BROKERAGE]);

    // Only the hashes of the parts it read.
    expect(await here.catchUp(part1)).toEqual({
      outcome: "moved",
      unsaved: true,
      hashes: [await sha256Hex(part1)],
    });
    expect(await accounts(here)).toEqual(["brokerage", "checking", "savings"]);

    const part2 = await save(here);
    expect(await partOf(part2)).toMatchObject({ previousHash: await sha256Hex(part1) });
    expect(await accounts(await openedFrom([part0, part1, part2]))).toEqual([
      "brokerage",
      "checking",
      "savings",
    ]);
  });

  it("brings in several parts at once, counting only its own changes as unsaved", async () => {
    const { here, elsewhere } = await twoCopies();
    await elsewhere.batch([INSERT_SAVINGS]);
    const part1 = await save(elsewhere);
    await elsewhere.batch([INSERT_BROKERAGE]);
    const part2 = await save(elsewhere);

    expect(await here.catchUp(concat([part1, part2]))).toEqual({
      outcome: "moved",
      unsaved: false,
      hashes: [await sha256Hex(part1), await sha256Hex(part2)],
    });
    expect(await accounts(here)).toEqual(["brokerage", "checking", "savings"]);
  });

  it("changes nothing when its changes conflict with those brought in", async () => {
    const { part0, here, elsewhere } = await twoCopies();
    await elsewhere.batch([{ sql: "UPDATE accounts SET type = 'Card' WHERE name = 'checking'" }]);
    const part1 = await save(elsewhere);
    await here.batch([{ sql: "UPDATE accounts SET type = 'Cash' WHERE name = 'checking'" }]);

    expect(await here.catchUp(part1)).toEqual({ outcome: "conflict", unsaved: true });

    expect(await here.query("SELECT type FROM accounts")).toEqual([{ type: "Cash" }]);
    expect((await here.prepareSave())?.previous).toBe(await sha256Hex(part0));
  });

  it("says parts that don't follow its last part need the whole chain, changing nothing", async () => {
    const { here } = await twoCopies();
    // Another database altogether, saved twice.
    const elsewhere = startWorker();
    await elsewhere.open(null, await kek());
    await elsewhere.batch([INSERT_SAVINGS]);
    const unrelated = await save(elsewhere);
    await elsewhere.batch([INSERT_BROKERAGE]);
    const after = await save(elsewhere);

    expect(await here.catchUp(after)).toEqual({ outcome: "unchained", unsaved: false });
    expect(await here.catchUp(concat([unrelated, after]))).toMatchObject({ outcome: "unchained" });
    expect(await accounts(here)).toEqual(["checking"]);
  });

  it("says parts written at another user version need the whole chain", async () => {
    const { part0, here } = await twoCopies();
    const older = await encryptPart(new Uint8Array(), await kek(), {
      previousHash: await sha256Hex(part0),
      userVersion: MIGRATIONS.length - 1,
    });

    expect(await here.catchUp(older)).toEqual({ outcome: "unchained", unsaved: false });
  });

  describe("with a change made there too", () => {
    const CHANGES = [
      ["the same delete", "DELETE FROM accounts WHERE name = 'checking'"],
      ["the same update", "UPDATE accounts SET type = 'Card' WHERE name = 'checking'"],
      ["the same insert", INSERT_SAVINGS.sql],
    ] as const;

    it.each(CHANGES)("takes %s as no conflict, leaving nothing unsaved", async (_name, sql) => {
      const { here, elsewhere } = await twoCopies();
      await elsewhere.batch([{ sql }]);
      const part1 = await save(elsewhere);
      await here.batch([{ sql }]);
      const expected = await accounts(elsewhere);

      expect(await here.catchUp(part1)).toMatchObject({ outcome: "moved", unsaved: false });
      expect(await accounts(here)).toEqual(expected);
    });

    it.each(CHANGES)("takes %s as no conflict in a full rebase too", async (_name, sql) => {
      const { part0, here, elsewhere } = await twoCopies();
      await elsewhere.batch([{ sql }]);
      const part1 = await save(elsewhere);
      await here.batch([{ sql }]);

      expect(await here.rebase(concat([part0, part1]))).toMatchObject({
        outcome: "moved",
        unsaved: false,
      });
    });

    it("updates the columns not made there, keeping them unsaved", async () => {
      const { here, elsewhere } = await twoCopies();
      await elsewhere.batch([{ sql: "UPDATE accounts SET type = 'Card' WHERE name = 'checking'" }]);
      const part1 = await save(elsewhere);
      await here.batch([
        { sql: "UPDATE accounts SET type = 'Card', identifier = '••1' WHERE name = 'checking'" },
      ]);

      expect(await here.catchUp(part1)).toMatchObject({ outcome: "moved", unsaved: true });
      expect(await here.query("SELECT type, identifier FROM accounts")).toEqual([
        { type: "Card", identifier: "••1" },
      ]);
    });

    it.each([
      ["an update to another value", "UPDATE accounts SET type = 'Cash' WHERE name = 'checking'"],
      ["a delete of a row changed there", "DELETE FROM accounts WHERE name = 'checking'"],
      [
        "an insert of another row by its key",
        "INSERT INTO accounts VALUES ('savings', 'EUR', 'Bank', NULL)",
      ],
    ])("still conflicts with %s", async (_name, sql) => {
      const { here, elsewhere } = await twoCopies();
      await elsewhere.batch([
        { sql: "UPDATE accounts SET type = 'Card' WHERE name = 'checking'" },
        INSERT_SAVINGS,
      ]);
      const part1 = await save(elsewhere);
      await here.batch([{ sql }]);

      expect(await here.catchUp(part1)).toEqual({ outcome: "conflict", unsaved: true });
    });

    it("leaves undo as strict as it was: an undo that no longer fits fails", async () => {
      const { here } = await twoCopies();
      const { changes } = await here.batch([INSERT_SAVINGS]);
      await here.undo(changes);

      await expect(here.undo(changes)).rejects.toThrow("The changes don't match the database");
    });
  });

  it("keeps edits made before it undoable, where the parts brought in didn't change them", async () => {
    const { here, elsewhere } = await twoCopies();
    await elsewhere.batch([INSERT_SAVINGS]);
    const part1 = await save(elsewhere);
    const { changes } = await here.batch([INSERT_BROKERAGE]);
    await here.catchUp(part1);

    expect(await here.undo(changes)).toEqual({ unsaved: false });
    expect(await accounts(here)).toEqual(["checking", "savings"]);
  });
});

describe("database worker changes", () => {
  async function opened() {
    const db = startWorker();
    await db.open(null, await kek());
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
    await db.prepareSave();

    expect(await db.finishSave(true)).toMatchObject({ unsaved: false });
    expect(await db.undo(changes)).toEqual({ unsaved: true });
    expect(await db.redo(changes)).toEqual({ unsaved: false });
  });

  it("keeps changes made during a save unsaved", async () => {
    const db = await opened();
    await db.batch([INSERT_CHECKING]);
    await db.prepareSave();
    await db.batch([INSERT_SAVINGS]);

    expect(await db.finishSave(true)).toMatchObject({ unsaved: true });
  });

  it("counts from the version last saved when a save fails", async () => {
    const db = await opened();
    const { changes } = await db.batch([INSERT_CHECKING]);
    await db.prepareSave();

    expect(await db.finishSave(false)).toEqual({ unsaved: true, sha256: null });
    expect(await db.undo(changes)).toEqual({ unsaved: false });
  });

  it("forgets a part that couldn't be encrypted", async () => {
    const db = startWorker();
    // Can't wrap the data key, so encrypting fails.
    const kek = await crypto.subtle.generateKey({ name: "AES-KW", length: 256 }, false, [
      "unwrapKey",
    ]);
    await db.open(null, kek);
    await db.batch([INSERT_CHECKING]);

    await rejection(db.prepareSave());

    // Had the part's version stayed, this would count it as saved.
    expect(await db.finishSave(true)).toEqual({ unsaved: true, sha256: null });
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
