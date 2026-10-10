import { afterEach, describe, expect, it } from "vitest";
import { connect, RemoteError, type Remote } from "./rpc.ts";
import type { DatabaseApi } from "./worker.ts";
import { MIGRATIONS } from "./migrations.ts";
import { deriveKek } from "../lib/kek.ts";
import { EXPORT_KEY } from "../test/fixtures.ts";

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
  });

  it("reopens an exported database with its data", async () => {
    const kek = await deriveKek(EXPORT_KEY);
    const first = startWorker();
    await first.open(null, kek);
    await first.query("INSERT INTO accounts VALUES (?, ?)", ["checking", "SGD"]);

    const blob = await first.export();
    const second = startWorker();

    expect(await second.open(blob, kek)).toEqual({ created: false });
    expect(await second.query("SELECT * FROM accounts")).toEqual([
      { name: "checking", default_currency: "SGD" },
    ]);
    expect(await second.query("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
  });

  it("keeps the database usable after an export", async () => {
    const db = startWorker();
    await db.open(null, await deriveKek(EXPORT_KEY));
    await db.export();

    await db.query("INSERT INTO accounts VALUES ('checking', 'SGD')");

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
    await db.query("INSERT INTO accounts VALUES ('checking', 'SGD')");

    await rejection(db.open(new Uint8Array([1, 2, 3]), kek));

    expect(await db.query("SELECT name FROM accounts")).toEqual([{ name: "checking" }]);
  });

  it("reports SQL errors with sqlite's message", async () => {
    const db = startWorker();
    await db.open(null, await deriveKek(EXPORT_KEY));

    const error = await rejection(db.query("SELECT * FROM missing"));

    expect((error as Error).message).toContain("no such table: missing");
  });
});
