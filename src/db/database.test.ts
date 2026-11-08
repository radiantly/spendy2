import { beforeEach, describe, expect, it, vi } from "vitest";
import { NO_PREVIOUS_PART, sha256Hex } from "../../worker/databaseParts.ts";
import { DatabaseOpenError, openDatabase, openNewerDatabase, type Database } from "./database.ts";
import { MIGRATIONS } from "./migrations.ts";
import { encryptPart } from "./parts.ts";
import { ClosedError } from "./rpc.ts";
import {
  appendDatabasePart,
  downloadDatabase,
  downloadDatabaseIfChanged,
  replaceDatabase,
  type DownloadResult,
} from "../api/database.ts";
import { deriveKek } from "../lib/kek.ts";
import type { Session } from "../lib/session.ts";
import { EXPORT_KEY, TOKEN } from "../test/fixtures.ts";

vi.mock("../api/database.ts", () => ({
  downloadDatabase: vi.fn(),
  downloadDatabaseIfChanged: vi.fn(),
  replaceDatabase: vi.fn(),
  appendDatabasePart: vi.fn(),
}));

async function session(): Promise<Session> {
  return { username: "alice", token: TOKEN, kek: await deriveKek(EXPORT_KEY) };
}

/** The parts the server stores, changed by the mocked API by the server's rules. */
let stored: Uint8Array<ArrayBuffer>[] = [];

const storedHead = async () => (stored.length === 0 ? null : sha256Hex(stored.at(-1)!));

function concat(parts: Uint8Array<ArrayBuffer>[]) {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

async function download(): Promise<DownloadResult> {
  if (stored.length === 0) return { success: false, code: "NOT_FOUND" };
  return { success: true, parts: concat(stored), sha256: (await storedHead())! };
}

beforeEach(() => {
  stored = [];
  vi.mocked(downloadDatabase).mockReset().mockImplementation(download);
  vi.mocked(downloadDatabaseIfChanged)
    .mockReset()
    .mockImplementation(async (_token, sha256) =>
      sha256 === (await storedHead()) ? { success: false, code: "NOT_MODIFIED" } : download(),
    );
  vi.mocked(replaceDatabase)
    .mockReset()
    .mockImplementation(async (_token, parts, precondition) => {
      const matches =
        "ifMatch" in precondition
          ? precondition.ifMatch === (await storedHead())
          : stored.length === 0;
      if (!matches) return { success: false, code: "CONFLICT" };
      // Copied: the caller's array is the part it keeps.
      stored = [parts.slice()];
      return { success: true, sha256: (await storedHead())! };
    });
  vi.mocked(appendDatabasePart)
    .mockReset()
    .mockImplementation(async (_token, part, ifMatch) => {
      if (stored.length === 0 || ifMatch !== (await storedHead()))
        return { success: false, code: "CONFLICT" };
      stored.push(part.slice());
      return { success: true, sha256: (await storedHead())! };
    });
});

const INSERT_CHECKING = [{ sql: "INSERT INTO accounts VALUES ('checking', 'USD', 'Bank', NULL)" }];
const INSERT_SAVINGS = [{ sql: "INSERT INTO accounts VALUES ('savings', 'USD', 'Bank', NULL)" }];

const accountsOf = async (db: Database) =>
  (await db.query("SELECT name FROM accounts ORDER BY name")).map(({ name }) => name);

/** What a database opened now from what's stored has, as its accounts. */
async function storedAccounts() {
  const db = await openDatabase(await session());
  try {
    return await accountsOf(db);
  } finally {
    db.close();
  }
}

/** A database saved with the accounts the statements insert, open, and a second copy of it. */
async function twoCopies(...statements: { sql: string }[][]) {
  const creator = await openDatabase(await session());
  for (const batch of statements) await creator.batch(batch);
  await creator.save();
  creator.close();
  return [await openDatabase(await session()), await openDatabase(await session())] as const;
}

describe("openDatabase", () => {
  it("creates a database when none is stored, without uploading it", async () => {
    const db = await openDatabase(await session());

    expect(db.sha256).toBeNull();
    expect(await db.query("SELECT count(*) AS n FROM transactions")).toEqual([{ n: 0 }]);
    expect(replaceDatabase).not.toHaveBeenCalled();
    db.close();
  });

  it("opens the stored database, based on its last part", async () => {
    const previous = await openDatabase(await session());
    await previous.batch(INSERT_CHECKING);
    await previous.save();
    await previous.batch(INSERT_SAVINGS);
    await previous.save();
    previous.close();

    const db = await openDatabase(await session());

    expect(db.sha256).toBe(await storedHead());
    expect(await accountsOf(db)).toEqual(["checking", "savings"]);
    db.close();
  });

  it("sends the session token", async () => {
    (await openDatabase(await session())).close();

    expect(downloadDatabase).toHaveBeenCalledWith(TOKEN);
  });

  it.each(["UNAUTHORIZED", "DOWNLOAD_FAILED"] as const)(
    "throws when the download is %s",
    async (code) => {
      vi.mocked(downloadDatabase).mockResolvedValue({ success: false, code });

      const error = await openDatabase(await session()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(DatabaseOpenError);
      expect((error as DatabaseOpenError).code).toBe(code);
    },
  );

  it("starts the worker before the download finishes, so SQLite loads meanwhile", async () => {
    const workers = vi.spyOn(globalThis, "Worker");
    let startedBeforeDownload = 0;
    vi.mocked(downloadDatabase).mockImplementation(async () => {
      startedBeforeDownload = workers.mock.calls.length;
      return { success: false, code: "NOT_FOUND" };
    });

    (await openDatabase(await session())).close();

    expect(startedBeforeDownload).toBe(1);
  });

  it.each([
    ["the download fails", { success: false, code: "DOWNLOAD_FAILED" } as const],
    ["the network fails", new TypeError("Failed to fetch")],
  ])("stops the worker it started when %s", async (_name, outcome) => {
    const terminate = vi.spyOn(Worker.prototype, "terminate");
    if (outcome instanceof Error) vi.mocked(downloadDatabase).mockRejectedValue(outcome);
    else vi.mocked(downloadDatabase).mockResolvedValue(outcome);

    await expect(openDatabase(await session())).rejects.toThrow();

    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("throws the part error when the stored database can't be decrypted", async () => {
    stored = [
      await encryptPart(new Uint8Array(), await deriveKek("b3RoZXIga2V5"), {
        previousHash: NO_PREVIOUS_PART,
        userVersion: 1,
      }),
    ];

    await expect(openDatabase(await session())).rejects.toMatchObject({
      code: "DECRYPTION_FAILED",
    });
  });
});

describe("Database.save", () => {
  it("creates the stored database on the first save, then adds what changed after it", async () => {
    const db = await openDatabase(await session());

    const first = await db.save();
    const part0 = await storedHead();
    expect(first).toEqual({ success: true, sha256: part0 });
    expect(replaceDatabase).toHaveBeenCalledWith(TOKEN, expect.any(Uint8Array), {
      ifNoneMatch: true,
    });

    await db.batch(INSERT_CHECKING);
    const second = await db.save();

    expect(appendDatabasePart).toHaveBeenCalledWith(TOKEN, expect.any(Uint8Array), part0);
    expect(stored).toHaveLength(2);
    expect(second).toEqual({ success: true, sha256: await storedHead() });
    expect(db.sha256).toBe(await storedHead());
    expect(await storedAccounts()).toEqual(["checking"]);
    db.close();
  });

  it("uploads nothing when nothing changed since the version saved", async () => {
    const db = await openDatabase(await session());
    await db.batch(INSERT_CHECKING);
    const saved = await db.save();

    expect(await db.save()).toEqual(saved);

    expect(replaceDatabase).toHaveBeenCalledTimes(1);
    expect(appendDatabasePart).not.toHaveBeenCalled();
    db.close();
  });

  it("waits for an earlier save, so saves close together don't conflict", async () => {
    const db = await openDatabase(await session());
    await db.save();
    const append = vi.mocked(appendDatabasePart).getMockImplementation()!;
    vi.mocked(appendDatabasePart).mockImplementation(async (...args) => {
      // Slow enough that the second save starts before the first finishes.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return append(...args);
    });

    await db.batch(INSERT_CHECKING);
    const first = db.save();
    // An edit once the first is uploading, for the second to save.
    await vi.waitFor(() => expect(appendDatabasePart).toHaveBeenCalled());
    await db.batch(INSERT_SAVINGS);
    const results = await Promise.all([first, db.save()]);

    expect(results.map(({ success }) => success)).toEqual([true, true]);
    expect(stored).toHaveLength(3);
    expect(await storedAccounts()).toEqual(["checking", "savings"]);
    db.close();
  });

  it("still saves after an earlier save threw", async () => {
    const db = await openDatabase(await session());
    vi.mocked(replaceDatabase).mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const [first, second] = await Promise.allSettled([db.save(), db.save()]);

    expect(first.status).toBe("rejected");
    expect(second).toEqual({
      status: "fulfilled",
      value: { success: true, sha256: await storedHead() },
    });
    db.close();
  });

  it("rejects calls still running when it is closed", async () => {
    const db = await openDatabase(await session());
    vi.mocked(replaceDatabase).mockImplementation(() => new Promise(() => {}));
    // The part is made in the worker; close before it answers.
    const save = db.save();

    db.close();

    await expect(save).rejects.toThrow(ClosedError);
  });

  it("rejects a save with the upload's error, even if it closed during the upload", async () => {
    const db = await openDatabase(await session());
    const error = new TypeError("Failed to fetch");
    let failUpload!: () => void;
    vi.mocked(replaceDatabase).mockImplementation(
      () => new Promise((_, reject) => (failUpload = () => reject(error))),
    );
    const save = db.save();
    await vi.waitFor(() => expect(replaceDatabase).toHaveBeenCalled());

    db.close();
    failUpload();

    await expect(save).rejects.toBe(error);
  });

  it("rejects calls made after it is closed", async () => {
    const db = await openDatabase(await session());

    db.close();

    await expect(db.query("SELECT 1")).rejects.toThrow(ClosedError);
  });

  describe("after a version was saved elsewhere", () => {
    it("moves its changes onto that version, bringing in what changed there, and saves", async () => {
      const [here, elsewhere] = await twoCopies(INSERT_CHECKING);
      await elsewhere.batch(INSERT_SAVINGS);
      await elsewhere.save();
      await here.batch([
        { sql: "INSERT INTO accounts VALUES ('brokerage', 'USD', 'Broker', NULL)" },
      ]);

      expect(await here.save()).toEqual({ success: true, sha256: await storedHead() });

      expect(await storedAccounts()).toEqual(["brokerage", "checking", "savings"]);
      expect(await accountsOf(here)).toEqual(["brokerage", "checking", "savings"]);
      expect(here.unsaved).toBe(false);
      here.close();
      elsewhere.close();
    });

    it("tells its listeners it rebased, and that the data changed", async () => {
      const [here, elsewhere] = await twoCopies(INSERT_CHECKING);
      await elsewhere.batch(INSERT_SAVINGS);
      await elsewhere.save();
      await here.batch([{ sql: "UPDATE accounts SET type = 'Card'" }]);
      const { version } = here;
      const listener = vi.fn();
      here.subscribe(listener);

      await here.save();

      expect(here.rebases).toBe(1);
      expect(here.version).toBe(version + 1);
      expect(listener).toHaveBeenCalled();
      here.close();
      elsewhere.close();
    });

    it("returns a conflict when its changes conflict with what changed there, changing nothing", async () => {
      const [here, elsewhere] = await twoCopies(INSERT_CHECKING);
      await elsewhere.batch([{ sql: "UPDATE accounts SET type = 'Card'" }]);
      await elsewhere.save();
      await here.batch([{ sql: "UPDATE accounts SET type = 'Cash'" }]);
      const base = here.sha256;

      expect(await here.save()).toEqual({ success: false, code: "CONFLICT" });

      expect(here.sha256).toBe(base);
      expect(here.rebases).toBe(0);
      expect(here.unsaved).toBe(true);
      expect(await here.query("SELECT type FROM accounts")).toEqual([{ type: "Cash" }]);
      here.close();
      elsewhere.close();
    });

    it("moves its changes onto a database first saved elsewhere", async () => {
      const here = await openDatabase(await session());
      const elsewhere = await openDatabase(await session());
      await elsewhere.batch(INSERT_CHECKING);
      await elsewhere.save();
      await here.batch(INSERT_SAVINGS);

      expect(await here.save()).toMatchObject({ success: true });

      expect(await storedAccounts()).toEqual(["checking", "savings"]);
      here.close();
      elsewhere.close();
    });

    it("gives up after moving its changes a few times, returning a conflict", async () => {
      const [here, elsewhere] = await twoCopies(INSERT_CHECKING);
      await here.batch(INSERT_SAVINGS);
      // Always a version newer than the one it just moved onto.
      vi.mocked(appendDatabasePart).mockResolvedValue({ success: false, code: "CONFLICT" });

      expect(await here.save()).toEqual({ success: false, code: "CONFLICT" });

      expect(appendDatabasePart).toHaveBeenCalledTimes(4);
      expect(here.unsaved).toBe(true);
      here.close();
      elsewhere.close();
    });

    it("returns UNAUTHORIZED when the session ended", async () => {
      const [here, elsewhere] = await twoCopies(INSERT_CHECKING);
      await elsewhere.batch(INSERT_SAVINGS);
      await elsewhere.save();
      await here.batch([{ sql: "UPDATE accounts SET type = 'Card'" }]);
      vi.mocked(downloadDatabase).mockResolvedValueOnce({ success: false, code: "UNAUTHORIZED" });

      expect(await here.save()).toEqual({ success: false, code: "UNAUTHORIZED" });
      here.close();
      elsewhere.close();
    });

    it("returns NEWER_VERSION when that version was saved by a newer app", async () => {
      const [here, elsewhere] = await twoCopies(INSERT_CHECKING);
      stored.push(
        await encryptPart(new Uint8Array(), await deriveKek(EXPORT_KEY), {
          previousHash: (await storedHead())!,
          userVersion: MIGRATIONS.length + 1,
        }),
      );
      await here.batch(INSERT_SAVINGS);

      expect(await here.save()).toEqual({ success: false, code: "NEWER_VERSION" });

      expect(here.unsaved).toBe(true);
      expect(await accountsOf(here)).toEqual(["checking", "savings"]);
      here.close();
      elsewhere.close();
    });
  });
});

describe("openNewerDatabase", () => {
  it("asks for the stored version only if it isn't the one open", async () => {
    const [current, other] = await twoCopies(INSERT_CHECKING);

    expect(await openNewerDatabase(await session(), current)).toBeNull();
    expect(downloadDatabaseIfChanged).toHaveBeenCalledWith(TOKEN, current.sha256);
    current.close();
    other.close();
  });

  it("opens a newer version", async () => {
    const [current, other] = await twoCopies(INSERT_CHECKING);
    await other.batch(INSERT_SAVINGS);
    await other.save();

    const newer = await openNewerDatabase(await session(), current);

    expect(newer!.sha256).toBe(await storedHead());
    expect(await accountsOf(newer!)).toEqual(["checking", "savings"]);
    // The open one is left to its owner.
    expect(await accountsOf(current)).toEqual(["checking"]);
    newer!.close();
    current.close();
    other.close();
  });

  it("ignores a download of the version already open", async () => {
    const [current, other] = await twoCopies(INSERT_CHECKING);
    vi.mocked(downloadDatabaseIfChanged).mockImplementation(download);

    expect(await openNewerDatabase(await session(), current)).toBeNull();
    current.close();
    other.close();
  });

  it("opens a database first saved elsewhere, when this one never was", async () => {
    const current = await openDatabase(await session());
    const [other] = await twoCopies(INSERT_SAVINGS);

    const newer = await openNewerDatabase(await session(), current);

    expect(newer!.sha256).toBe(await storedHead());
    expect(downloadDatabaseIfChanged).not.toHaveBeenCalled();
    newer!.close();
    current.close();
    other.close();
  });

  it("returns null while a database that was never saved still isn't", async () => {
    const current = await openDatabase(await session());

    expect(await openNewerDatabase(await session(), current)).toBeNull();
    current.close();
  });

  it("returns null when the stored database is gone", async () => {
    const [current, other] = await twoCopies(INSERT_CHECKING);
    stored = [];

    expect(await openNewerDatabase(await session(), current)).toBeNull();
    current.close();
    other.close();
  });

  it.each(["UNAUTHORIZED", "DOWNLOAD_FAILED"] as const)(
    "throws when the download is %s",
    async (code) => {
      const [current, other] = await twoCopies(INSERT_CHECKING);
      vi.mocked(downloadDatabaseIfChanged).mockResolvedValue({ success: false, code });

      await expect(openNewerDatabase(await session(), current)).rejects.toMatchObject({ code });
      current.close();
      other.close();
    },
  );
});

describe("Database.unsaved", () => {
  it("is false when opened", async () => {
    const db = await openDatabase(await session());

    expect(db.unsaved).toBe(false);
    db.close();
  });

  it("is true as soon as a write is asked for", async () => {
    const db = await openDatabase(await session());
    const listener = vi.fn();
    db.subscribe(listener);

    const written = db.batch(INSERT_CHECKING);

    expect(db.unsaved).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    await written;
    expect(db.unsaved).toBe(true);
    db.close();
  });

  it("is false once a write is undone, and true when it's redone", async () => {
    const db = await openDatabase(await session());
    const changes = await db.batch(INSERT_CHECKING);

    await db.undo(changes);
    expect(db.unsaved).toBe(false);
    await db.redo(changes);
    expect(db.unsaved).toBe(true);
    db.close();
  });

  it("isn't cleared by an earlier write's answer while a later one runs", async () => {
    const db = await openDatabase(await session());
    const changes = await db.batch(INSERT_CHECKING);

    const undone = db.undo(changes);
    const written = db.batch(INSERT_SAVINGS);
    await undone;

    expect(db.unsaved).toBe(true);
    await written;
    expect(db.unsaved).toBe(true);
    db.close();
  });

  it("is false after a save, and true again for an edit made during it", async () => {
    const db = await openDatabase(await session());
    await db.batch(INSERT_CHECKING);

    await db.save();
    expect(db.unsaved).toBe(false);

    await db.batch([{ sql: "UPDATE accounts SET type = 'Card'" }]);
    const append = vi.mocked(appendDatabasePart).getMockImplementation()!;
    let finishUpload!: () => void;
    vi.mocked(appendDatabasePart).mockImplementation(
      (...args) => new Promise((resolve) => (finishUpload = () => resolve(append(...args)))),
    );
    const saved = db.save();
    await vi.waitFor(() => expect(appendDatabasePart).toHaveBeenCalled());
    await db.batch(INSERT_SAVINGS);
    finishUpload();
    await saved;

    expect(db.unsaved).toBe(true);
    db.close();
  });

  it("stays true when a save fails or throws", async () => {
    const db = await openDatabase(await session());
    await db.batch(INSERT_CHECKING);
    vi.mocked(replaceDatabase).mockResolvedValueOnce({ success: false, code: "UPLOAD_FAILED" });
    vi.mocked(replaceDatabase).mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await db.save();
    expect(db.unsaved).toBe(true);
    await db.save().catch(() => {});
    expect(db.unsaved).toBe(true);
    db.close();
  });

  it("goes back to what the database has when a write fails", async () => {
    const db = await openDatabase(await session());

    await db.batch([...INSERT_CHECKING, ...INSERT_CHECKING]).catch(() => {});

    expect(db.unsaved).toBe(false);
    db.close();
  });
});
