import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseOpenError, openDatabase, openNewerDatabase } from "./database.ts";
import { ClosedError } from "./rpc.ts";
import { encryptDatabase } from "./blob.ts";
import { downloadDatabase, downloadDatabaseIfChanged, uploadDatabase } from "../api/database.ts";
import { deriveKek } from "../lib/kek.ts";
import type { Session } from "../lib/session.ts";
import { EXPORT_KEY, TOKEN } from "../test/fixtures.ts";

vi.mock("../api/database.ts", () => ({
  downloadDatabase: vi.fn(),
  downloadDatabaseIfChanged: vi.fn(),
  uploadDatabase: vi.fn(),
}));

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

async function session(): Promise<Session> {
  return { username: "alice", token: TOKEN, kek: await deriveKek(EXPORT_KEY) };
}

beforeEach(() => {
  vi.mocked(downloadDatabase).mockReset();
  vi.mocked(uploadDatabase).mockReset();
  vi.mocked(downloadDatabaseIfChanged).mockReset();
  vi.mocked(downloadDatabase).mockResolvedValue({ success: false, code: "NOT_FOUND" });
  vi.mocked(uploadDatabase).mockResolvedValue({ success: true, sha256: SHA_A });
});

describe("openDatabase", () => {
  it("creates a database when none is stored, without uploading it", async () => {
    const db = await openDatabase(await session());

    expect(db.sha256).toBeNull();
    expect(await db.query("SELECT count(*) AS n FROM transactions")).toEqual([{ n: 0 }]);
    expect(uploadDatabase).not.toHaveBeenCalled();
    db.close();
  });

  it("opens the stored database", async () => {
    // A stored database made by a previous session.
    const previous = await openDatabase(await session());
    await previous.query("INSERT INTO accounts VALUES ('checking', 'SGD', 'Bank', NULL)");
    await previous.save();
    const [, uploaded] = vi.mocked(uploadDatabase).mock.calls[0]!;
    previous.close();
    vi.mocked(downloadDatabase).mockResolvedValue({ success: true, blob: uploaded, sha256: SHA_A });

    const db = await openDatabase(await session());

    expect(db.sha256).toBe(SHA_A);
    expect(await db.query("SELECT name FROM accounts")).toEqual([{ name: "checking" }]);
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

  it("throws the blob error when the stored database can't be decrypted", async () => {
    const blob = await encryptDatabase(new Uint8Array(), await deriveKek("b3RoZXIga2V5"));
    vi.mocked(downloadDatabase).mockResolvedValue({ success: true, blob, sha256: SHA_A });

    await expect(openDatabase(await session())).rejects.toMatchObject({
      code: "DECRYPTION_FAILED",
    });
  });
});

describe("Database.save", () => {
  it("creates the stored database on the first save, then replaces the saved version", async () => {
    const db = await openDatabase(await session());

    expect(await db.save()).toEqual({ success: true, sha256: SHA_A });
    vi.mocked(uploadDatabase).mockResolvedValue({ success: true, sha256: SHA_B });
    await db.save();

    const preconditions = vi
      .mocked(uploadDatabase)
      .mock.calls.map(([, , precondition]) => precondition);
    expect(preconditions).toEqual([{ ifNoneMatch: true }, { ifMatch: SHA_A }]);
    expect(db.sha256).toBe(SHA_B);
    db.close();
  });

  it("waits for an earlier save, so saves close together don't conflict", async () => {
    const db = await openDatabase(await session());
    let uploads = 0;
    vi.mocked(uploadDatabase).mockImplementation(async () => {
      // Slow enough that the second save starts before the first finishes.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { success: true, sha256: ++uploads === 1 ? SHA_A : SHA_B };
    });

    const results = await Promise.all([db.save(), db.save()]);

    expect(results).toEqual([
      { success: true, sha256: SHA_A },
      { success: true, sha256: SHA_B },
    ]);
    const preconditions = vi
      .mocked(uploadDatabase)
      .mock.calls.map(([, , precondition]) => precondition);
    expect(preconditions).toEqual([{ ifNoneMatch: true }, { ifMatch: SHA_A }]);
    expect(db.sha256).toBe(SHA_B);
    db.close();
  });

  it("still saves after an earlier save threw", async () => {
    const db = await openDatabase(await session());
    vi.mocked(uploadDatabase).mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const [first, second] = await Promise.allSettled([db.save(), db.save()]);

    expect(first.status).toBe("rejected");
    expect(second).toEqual({ status: "fulfilled", value: { success: true, sha256: SHA_A } });
    db.close();
  });

  it("rejects calls still running when it is closed", async () => {
    const db = await openDatabase(await session());
    vi.mocked(uploadDatabase).mockImplementation(() => new Promise(() => {}));
    // Export runs in the worker; close before it answers.
    const save = db.save();

    db.close();

    await expect(save).rejects.toThrow(ClosedError);
  });

  it("rejects a save with the upload's error, even if it closed during the upload", async () => {
    const db = await openDatabase(await session());
    const error = new TypeError("Failed to fetch");
    let failUpload!: () => void;
    vi.mocked(uploadDatabase).mockImplementation(
      () => new Promise((_, reject) => (failUpload = () => reject(error))),
    );
    const save = db.save();
    await vi.waitFor(() => expect(uploadDatabase).toHaveBeenCalled());

    db.close();
    failUpload();

    await expect(save).rejects.toBe(error);
  });

  it("rejects calls made after it is closed", async () => {
    const db = await openDatabase(await session());

    db.close();

    await expect(db.query("SELECT 1")).rejects.toThrow(ClosedError);
  });

  it("uploads with the session token", async () => {
    const db = await openDatabase(await session());

    await db.save();

    expect(vi.mocked(uploadDatabase).mock.calls[0]![0]).toBe(TOKEN);
    db.close();
  });

  it("returns a conflict and keeps the version it is based on", async () => {
    const db = await openDatabase(await session());
    await db.save();
    vi.mocked(uploadDatabase).mockResolvedValue({ success: false, code: "CONFLICT" });

    expect(await db.save()).toEqual({ success: false, code: "CONFLICT" });

    expect(db.sha256).toBe(SHA_A);
    db.close();
  });
});

describe("openNewerDatabase", () => {
  /** A stored database with one account, `name`. */
  async function storedWithAccount(name: string) {
    const db = await openDatabase(await session());
    await db.query("INSERT INTO accounts VALUES (?, 'SGD', 'Bank', NULL)", [name]);
    await db.save();
    const blob = vi.mocked(uploadDatabase).mock.calls.at(-1)![1];
    db.close();
    return blob;
  }

  /** The database open here, saved as SHA_A. */
  async function openSaved() {
    const blob = await storedWithAccount("checking");
    vi.mocked(downloadDatabase).mockResolvedValueOnce({ success: true, blob, sha256: SHA_A });
    return openDatabase(await session());
  }

  it("asks for the stored version only if it isn't the one open", async () => {
    const current = await openSaved();
    vi.mocked(downloadDatabaseIfChanged).mockResolvedValue({
      success: false,
      code: "NOT_MODIFIED",
    });

    expect(await openNewerDatabase(await session(), current)).toBeNull();
    expect(downloadDatabaseIfChanged).toHaveBeenCalledWith(TOKEN, SHA_A);
    current.close();
  });

  it("opens a newer version", async () => {
    const current = await openSaved();
    const blob = await storedWithAccount("savings");
    vi.mocked(downloadDatabaseIfChanged).mockResolvedValue({ success: true, blob, sha256: SHA_B });

    const newer = await openNewerDatabase(await session(), current);

    expect(newer!.sha256).toBe(SHA_B);
    expect(await newer!.query("SELECT name FROM accounts")).toEqual([{ name: "savings" }]);
    // The open one is left to its owner.
    expect(await current.query("SELECT name FROM accounts")).toEqual([{ name: "checking" }]);
    newer!.close();
    current.close();
  });

  it("ignores a download of the version already open", async () => {
    const current = await openSaved();
    const blob = await storedWithAccount("checking");
    vi.mocked(downloadDatabaseIfChanged).mockResolvedValue({ success: true, blob, sha256: SHA_A });

    expect(await openNewerDatabase(await session(), current)).toBeNull();
    current.close();
  });

  it("opens a database first saved elsewhere, when this one never was", async () => {
    const current = await openDatabase(await session());
    const blob = await storedWithAccount("savings");
    vi.mocked(downloadDatabase).mockResolvedValue({ success: true, blob, sha256: SHA_B });

    const newer = await openNewerDatabase(await session(), current);

    expect(newer!.sha256).toBe(SHA_B);
    expect(downloadDatabaseIfChanged).not.toHaveBeenCalled();
    newer!.close();
    current.close();
  });

  it("returns null while a database that was never saved still isn't", async () => {
    const current = await openDatabase(await session());

    expect(await openNewerDatabase(await session(), current)).toBeNull();
    current.close();
  });

  it("returns null when the stored database is gone", async () => {
    const current = await openSaved();
    vi.mocked(downloadDatabaseIfChanged).mockResolvedValue({ success: false, code: "NOT_FOUND" });

    expect(await openNewerDatabase(await session(), current)).toBeNull();
    current.close();
  });

  it.each(["UNAUTHORIZED", "DOWNLOAD_FAILED"] as const)(
    "throws when the download is %s",
    async (code) => {
      const current = await openSaved();
      vi.mocked(downloadDatabaseIfChanged).mockResolvedValue({ success: false, code });

      await expect(openNewerDatabase(await session(), current)).rejects.toMatchObject({ code });
      current.close();
    },
  );
});

describe("Database.unsaved", () => {
  const INSERT = [{ sql: "INSERT INTO accounts VALUES ('checking', 'USD', 'Bank', NULL)" }];

  it("is false when opened", async () => {
    const db = await openDatabase(await session());

    expect(db.unsaved).toBe(false);
    db.close();
  });

  it("is true as soon as a write is asked for", async () => {
    const db = await openDatabase(await session());
    const listener = vi.fn();
    db.subscribe(listener);

    const written = db.batch(INSERT);

    expect(db.unsaved).toBe(true);
    expect(listener).toHaveBeenCalledOnce();
    await written;
    expect(db.unsaved).toBe(true);
    db.close();
  });

  it("is false once a write is undone, and true when it's redone", async () => {
    const db = await openDatabase(await session());
    const changes = await db.batch(INSERT);

    await db.undo(changes);
    expect(db.unsaved).toBe(false);
    await db.redo(changes);
    expect(db.unsaved).toBe(true);
    db.close();
  });

  it("isn't cleared by an earlier write's answer while a later one runs", async () => {
    const db = await openDatabase(await session());
    const changes = await db.batch(INSERT);

    const undone = db.undo(changes);
    const written = db.batch([
      { sql: "INSERT INTO accounts VALUES ('savings', 'USD', 'Bank', NULL)" },
    ]);
    await undone;

    expect(db.unsaved).toBe(true);
    await written;
    expect(db.unsaved).toBe(true);
    db.close();
  });

  it("is false after a save, and true again for an edit made during it", async () => {
    const db = await openDatabase(await session());
    await db.batch(INSERT);

    await db.save();
    expect(db.unsaved).toBe(false);

    let finishUpload!: () => void;
    vi.mocked(uploadDatabase).mockImplementation(
      () =>
        new Promise((resolve) => (finishUpload = () => resolve({ success: true, sha256: SHA_B }))),
    );
    const saved = db.save();
    await vi.waitFor(() => expect(uploadDatabase).toHaveBeenCalledTimes(2));
    await db.batch([{ sql: "INSERT INTO accounts VALUES ('savings', 'USD', 'Bank', NULL)" }]);
    finishUpload();
    await saved;

    expect(db.unsaved).toBe(true);
    db.close();
  });

  it("stays true when a save fails or throws", async () => {
    const db = await openDatabase(await session());
    await db.batch(INSERT);
    vi.mocked(uploadDatabase).mockResolvedValueOnce({ success: false, code: "CONFLICT" });
    vi.mocked(uploadDatabase).mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await db.save();
    expect(db.unsaved).toBe(true);
    await db.save().catch(() => {});
    expect(db.unsaved).toBe(true);
    db.close();
  });

  it("goes back to what the database has when a write fails", async () => {
    const db = await openDatabase(await session());

    await db.batch([...INSERT, ...INSERT]).catch(() => {});

    expect(db.unsaved).toBe(false);
    db.close();
  });
});
