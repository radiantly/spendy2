import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseOpenError, openDatabase } from "./database.ts";
import { ClosedError } from "./rpc.ts";
import { encryptDatabase } from "./blob.ts";
import { downloadDatabase, uploadDatabase } from "../api/database.ts";
import { deriveKek } from "../lib/kek.ts";
import type { Session } from "../lib/session.ts";
import { EXPORT_KEY, TOKEN } from "../test/fixtures.ts";

vi.mock("../api/database.ts", () => ({ downloadDatabase: vi.fn(), uploadDatabase: vi.fn() }));

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

async function session(): Promise<Session> {
  return { username: "alice", token: TOKEN, kek: await deriveKek(EXPORT_KEY) };
}

beforeEach(() => {
  vi.mocked(downloadDatabase).mockReset();
  vi.mocked(uploadDatabase).mockReset();
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
    await previous.query("INSERT INTO accounts VALUES ('checking', 'SGD')");
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
