import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import * as opaque from "@serenity-kit/opaque";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { NO_PREVIOUS_PART, sha256Hex } from "../databaseParts.ts";
import {
  chainedParts,
  concatBytes,
  databasePart,
  loginToken,
  registerUser,
} from "../test/helpers.ts";
import { DATABASE_CHUNK_BYTES } from "./StoredDatabase.ts";
import type { UserStore } from "./UserStore.ts";

const CLEANUP_DELAY_MS = env.USER_CLEANUP_DELAY_SECONDS * 1000;

beforeAll(() => opaque.ready);
afterEach(() => reset());

function startLoginRequest() {
  return opaque.client.startLogin({ password: "password" }).startLoginRequest;
}

/** The body of an upload: `parts`, one after the other. */
const streamOf = (...parts: Uint8Array[]) => new Response(concatBytes(parts)).body!;

function getRegistrationRecord(state: DurableObjectState) {
  return state.storage.kv.get<string>("REGISTRATION_RECORD");
}

/**
 * Whether anything is stored: a key, or a table other than the runtime's
 * internal ones. Both are checked, so the answer doesn't depend on which one
 * the durable object happens to use.
 */
function hasStorage(state: DurableObjectState) {
  const hasKeys = [...state.storage.kv.list()].length > 0;
  const hasTables =
    state.storage.sql
      .exec(
        `
        SELECT 1 FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE '\\_cf%' ESCAPE '\\'
          AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\';`,
      )
      .toArray().length > 0;
  return hasKeys || hasTables;
}

describe("UserStore", () => {
  it("does not create storage before the first write", async () => {
    const stub = env.USER.getByName("alice");

    await runInDurableObject(stub, (_instance, state) => {
      expect(hasStorage(state)).toBe(false);
    });
  });

  it("stores the registration record and schedules expiry after the cleanup delay", async () => {
    const stub = env.USER.getByName("alice");

    await runInDurableObject(stub, async (instance, state) => {
      const before = Date.now();
      await instance.registerNewUser("record");

      expect(getRegistrationRecord(state)).toBe("record");
      const alarm = await state.storage.getAlarm();
      expect(alarm).toBeGreaterThanOrEqual(before + CLEANUP_DELAY_MS);
      expect(alarm).toBeLessThanOrEqual(Date.now() + CLEANUP_DELAY_MS);
    });
  });

  it("rejects a second registration", async () => {
    const stub = env.USER.getByName("alice");

    await runInDurableObject(stub, async (instance, state) => {
      await instance.registerNewUser("first");

      expect(await instance.registerNewUser("second")).toEqual({
        success: false,
        code: "USER_ALREADY_EXISTS",
      });
      expect(getRegistrationRecord(state)).toBe("first");
    });
  });

  it("rejects an identical registration record again", async () => {
    const stub = env.USER.getByName("alice");
    await stub.registerNewUser("record");

    expect(await stub.registerNewUser("record")).toEqual({
      success: false,
      code: "USER_ALREADY_EXISTS",
    });
  });

  describe("alarm", () => {
    it("deletes all storage when the alarm fires before a login", async () => {
      const stub = env.USER.getByName("alice");
      await stub.registerNewUser("record");

      expect(await runDurableObjectAlarm(stub)).toBe(true);

      await runInDurableObject(stub, (_instance, state) => {
        expect(hasStorage(state)).toBe(false);
      });
    });

    it("allows registering again after the user was deleted", async () => {
      const stub = env.USER.getByName("alice");
      await stub.registerNewUser("first");
      await runDurableObjectAlarm(stub);

      await stub.registerNewUser("second");

      await runInDurableObject(stub, (_instance, state) => {
        expect(getRegistrationRecord(state)).toBe("second");
      });
    });

    it("deletes a user who logged in but never saved a database", async () => {
      const stub = env.USER.getByName("alice");
      await stub.registerNewUser("record");
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.kv.put("ACTIVE_SESSIONS", new Set([crypto.randomUUID()]));
      });

      expect(await runDurableObjectAlarm(stub)).toBe(true);

      await runInDurableObject(stub, (_instance, state) => {
        expect(hasStorage(state)).toBe(false);
      });
    });

    it("keeps a user who has saved a database", async () => {
      const stub = env.USER.getByName("alice");
      await stub.registerNewUser("record");
      const session = crypto.randomUUID();
      const part = databasePart(NO_PREVIOUS_PART);
      await runInDurableObject(stub, async (instance, state) => {
        state.storage.kv.put("ACTIVE_SESSIONS", new Set([session]));
        await instance.replaceDatabase(session, streamOf(part), null);
      });

      expect(await runDurableObjectAlarm(stub)).toBe(true);

      await runInDurableObject(stub, async (instance, state) => {
        expect(getRegistrationRecord(state)).toBe("record");
        expect(await instance.downloadDatabase(session, null)).toMatchObject({
          success: true,
          sha256: await sha256Hex(part),
        });
      });
    });
  });

  it("does not write storage when an unknown user starts a login", async () => {
    const stub = env.USER.getByName("nobody");

    await runInDurableObject(stub, async (instance, state) => {
      const result = await instance.startLoginRatelimited(startLoginRequest());

      expect(result.success).toBe(true);
      expect(hasStorage(state)).toBe(false);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it("does not move the registration expiry when a registered user starts a login", async () => {
    const stub = env.USER.getByName("alice");
    await stub.registerNewUser("record");

    await runInDurableObject(stub, async (instance, state) => {
      const alarm = await state.storage.getAlarm();
      await instance.startLoginRatelimited(startLoginRequest());

      expect(await state.storage.getAlarm()).toBe(alarm);
    });
  });

  it("refuses to start a login when not addressed by name", async () => {
    const stub = env.USER.get(env.USER.newUniqueId());

    await runInDurableObject(stub, async (instance, state) => {
      await expect(instance.startLoginRatelimited(startLoginRequest())).rejects.toThrow(
        "UserStore must be addressed by name",
      );
      expect(hasStorage(state)).toBe(false);
    });
  });

  describe("database", () => {
    it("does not write storage when an unknown user uploads or downloads", async () => {
      const stub = env.USER.getByName("nobody");
      const part = databasePart(NO_PREVIOUS_PART);

      await runInDurableObject(stub, async (instance, state) => {
        const unauthorized = { success: false, code: "UNAUTHORIZED" };
        const session = crypto.randomUUID();
        expect(await instance.replaceDatabase(session, streamOf(part), null)).toEqual(unauthorized);
        expect(
          await instance.appendDatabasePart(session, streamOf(part), NO_PREVIOUS_PART),
        ).toEqual(unauthorized);
        expect(await instance.downloadDatabase(session, null)).toEqual(unauthorized);
        expect(await instance.downloadDatabasePart(session, 0)).toEqual(unauthorized);

        expect(hasStorage(state)).toBe(false);
      });
    });

    const SESSION = crypto.randomUUID();

    /** Runs `fn` in alice's store, with SESSION logged in. */
    function inStore<R>(fn: (instance: UserStore, state: DurableObjectState) => Promise<R>) {
      return runInDurableObject(env.USER.getByName("alice"), (instance: UserStore, state) => {
        state.storage.kv.put("ACTIVE_SESSIONS", new Set([SESSION]));
        return fn(instance, state);
      });
    }

    const bytesOf = async (stream: ReadableStream<Uint8Array>) =>
      new Uint8Array(await new Response(stream).arrayBuffer());

    /** A download's body, once it's all read, and what the download said of it. */
    async function readDownload({
      body,
      byteLength,
      sha256,
    }: {
      body: ReadableStream<Uint8Array>;
      byteLength: number;
      sha256: string;
    }) {
      return { body: await bytesOf(body), byteLength, sha256 };
    }

    /** The stored database, as one download: every part and the last one's hash. */
    async function stored(instance: UserStore) {
      const result = await instance.downloadDatabase(SESSION, null);
      if (!result.success || !result.modified) return result;
      return readDownload(result);
    }

    /** What `stored` gives for `parts`, and `storedPart` for a single part. */
    async function storedAs(parts: Uint8Array<ArrayBuffer>[]) {
      const body = concatBytes(parts);
      return { body, byteLength: body.length, sha256: await sha256Hex(parts.at(-1)!) };
    }

    /** The part at `index`, as its download. */
    async function storedPart(instance: UserStore, index: number) {
      const result = await instance.downloadDatabasePart(SESSION, index);
      if (!result.success) return result;
      return readDownload(result);
    }

    it.each([
      ["less than a chunk", DATABASE_CHUNK_BYTES - 1],
      ["exactly a chunk", DATABASE_CHUNK_BYTES],
      ["just over a chunk", DATABASE_CHUNK_BYTES + 1],
      ["several chunks", 3 * DATABASE_CHUNK_BYTES + 12345],
    ])("returns a part of %s byte for byte, with its hash", async (_name, size) => {
      const [part] = await chainedParts({ size });
      const sha256 = await sha256Hex(part!);

      await inStore(async (instance) => {
        expect(await instance.replaceDatabase(SESSION, streamOf(part!), null)).toEqual({
          success: true,
          sha256,
        });
        const result = await instance.downloadDatabase(SESSION, null);

        if (!result.success || !result.modified) expect.unreachable(JSON.stringify(result));
        expect(result.sha256).toBe(sha256);
        expect(result.byteLength).toBe(size);
        // every() rather than toEqual: a failing toEqual would print megabytes
        const downloaded = await bytesOf(result.body);
        expect(downloaded.length).toBe(size);
        expect(downloaded.every((byte, i) => byte === part![i])).toBe(true);
      });
    });

    it("stores each part in rows of at most a chunk, all replaced by the next upload", async () => {
      await inStore(async (instance, state) => {
        const rows = () =>
          state.storage.sql
            .exec<{ part: number; size: number }>(
              `SELECT part, length(chunk) AS size FROM database_parts_chunks
               ORDER BY part, chunk_idx`,
            )
            .toArray()
            .map(({ part, size }) => [part, size]);

        const first = await chainedParts({ size: 2 * DATABASE_CHUNK_BYTES + 1 }, { size: 200 });
        await instance.replaceDatabase(SESSION, streamOf(...first), null);
        expect(rows()).toEqual([
          [0, DATABASE_CHUNK_BYTES],
          [0, DATABASE_CHUNK_BYTES],
          [0, 1],
          [1, 200],
        ]);

        const [second] = await chainedParts({ size: 300 });
        await instance.replaceDatabase(SESSION, streamOf(second!), await sha256Hex(first[1]!));
        expect(rows()).toEqual([[0, 300]]);
      });
    });

    it("returns every part one after the other, with the last part's hash", async () => {
      const parts = await chainedParts({}, { size: 300 }, {});

      await inStore(async (instance) => {
        expect(await instance.replaceDatabase(SESSION, streamOf(...parts), null)).toEqual({
          success: true,
          sha256: await sha256Hex(parts[2]!),
        });

        expect(await stored(instance)).toEqual(await storedAs(parts));
      });
    });

    it("returns each part on its own, with its own hash", async () => {
      const parts = await chainedParts({}, { size: 300 });

      await inStore(async (instance) => {
        await instance.replaceDatabase(SESSION, streamOf(...parts), null);

        for (const [i, part] of parts.entries())
          expect(await storedPart(instance, i)).toEqual(await storedAs([part]));
        expect(await instance.downloadDatabasePart(SESSION, 2)).toEqual({
          success: false,
          code: "NOT_FOUND",
        });
      });
    });

    it("finds no part without a database", async () => {
      await inStore(async (instance) => {
        expect(await instance.downloadDatabasePart(SESSION, 0)).toEqual({
          success: false,
          code: "NOT_FOUND",
        });
      });
    });

    it("adds parts after the last one", async () => {
      const [first, second, third] = await chainedParts({}, {}, {});

      await inStore(async (instance) => {
        await instance.replaceDatabase(SESSION, streamOf(first!), null);

        expect(
          await instance.appendDatabasePart(SESSION, streamOf(second!), await sha256Hex(first!)),
        ).toEqual({ success: true, sha256: await sha256Hex(second!) });
        expect(
          await instance.appendDatabasePart(SESSION, streamOf(third!), await sha256Hex(second!)),
        ).toEqual({ success: true, sha256: await sha256Hex(third!) });

        expect(await stored(instance)).toEqual(await storedAs([first!, second!, third!]));
        expect(await storedPart(instance, 2)).toEqual(await storedAs([third!]));
      });
    });

    describe("a download under way", () => {
      /** Reads what's left of a download, after `read`. */
      async function readRest(reader: ReadableStreamDefaultReader<Uint8Array>, read: Uint8Array[]) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return concatBytes(read);
          read.push(value);
        }
      }

      it.each([
        ["the database's", (instance: UserStore) => instance.downloadDatabase(SESSION, null)],
        ["a part's", (instance: UserStore) => instance.downloadDatabasePart(SESSION, 0)],
      ])("errors when %s parts are replaced partway through it", async (_name, download) => {
        const parts = await chainedParts({ size: 3 * DATABASE_CHUNK_BYTES });
        const [other] = await chainedParts({ seed: 9 });

        await inStore(async (instance) => {
          await instance.replaceDatabase(SESSION, streamOf(...parts), null);
          const result = await download(instance);
          if (!result.success || !("body" in result)) expect.unreachable(JSON.stringify(result));
          const reader = result.body.getReader();
          // reads from the first chunk
          await reader.read();

          await instance.replaceDatabase(SESSION, streamOf(other!), await sha256Hex(parts[0]!));

          await expect(readRest(reader, [])).rejects.toThrow(
            "The database was replaced while it was being read",
          );
        });
      });

      it("sends the database as it was when it started, without parts added since", async () => {
        const parts = await chainedParts({ size: 2 * DATABASE_CHUNK_BYTES }, {});
        const added = databasePart(await sha256Hex(parts[1]!));

        await inStore(async (instance) => {
          await instance.replaceDatabase(SESSION, streamOf(...parts), null);
          const result = await instance.downloadDatabase(SESSION, null);
          if (!result.success || !result.modified) expect.unreachable(JSON.stringify(result));
          const reader = result.body.getReader();
          const { value: first } = await reader.read();

          expect(
            await instance.appendDatabasePart(SESSION, streamOf(added), await sha256Hex(parts[1]!)),
          ).toMatchObject({ success: true });

          // hashes rather than toEqual: a failing toEqual would print megabytes
          const body = await readRest(reader, [first!]);
          expect(await sha256Hex(body)).toBe(await sha256Hex(concatBytes(parts)));
          expect(result.byteLength).toBe(body.length);
        });
      });
    });

    it("says the database is unmodified while given its last part's hash", async () => {
      const parts = await chainedParts({}, {});

      await inStore(async (instance) => {
        await instance.replaceDatabase(SESSION, streamOf(...parts), null);

        const sha256 = await sha256Hex(parts[1]!);
        expect(await instance.downloadDatabase(SESSION, sha256)).toEqual({
          success: true,
          modified: false,
          sha256,
        });
        expect(await instance.downloadDatabase(SESSION, await sha256Hex(parts[0]!))).toMatchObject({
          success: true,
          modified: true,
        });
      });
    });

    describe("preconditions", () => {
      const PRECONDITION_FAILED = { success: false, code: "PRECONDITION_FAILED" };

      it("leaves the stored database as it was when a replacement's fails", async () => {
        const parts = await chainedParts({}, {});
        const [other] = await chainedParts({ seed: 99 });

        await inStore(async (instance) => {
          await instance.replaceDatabase(SESSION, streamOf(...parts), null);

          // the first part's hash, another, or none at all, rather than the last part's
          for (const ifMatch of [await sha256Hex(parts[0]!), "9".repeat(64), null])
            expect(await instance.replaceDatabase(SESSION, streamOf(other!), ifMatch)).toEqual(
              PRECONDITION_FAILED,
            );
          expect(await stored(instance)).toEqual(await storedAs(parts));
        });
      });

      it("leaves the stored database as it was when an addition's fails", async () => {
        const parts = await chainedParts({}, {});
        // follows the first part, which is no longer the last
        const late = databasePart(await sha256Hex(parts[0]!), { seed: 99 });

        await inStore(async (instance) => {
          await instance.replaceDatabase(SESSION, streamOf(...parts), null);

          expect(
            await instance.appendDatabasePart(SESSION, streamOf(late), await sha256Hex(parts[0]!)),
          ).toEqual(PRECONDITION_FAILED);
          expect(await stored(instance)).toEqual(await storedAs(parts));
        });
      });

      it("can't create a database by adding a part", async () => {
        await inStore(async (instance, state) => {
          const part = databasePart(NO_PREVIOUS_PART);

          expect(
            await instance.appendDatabasePart(SESSION, streamOf(part), NO_PREVIOUS_PART),
          ).toEqual(PRECONDITION_FAILED);
          expect(await stored(instance)).toEqual({ success: false, code: "NOT_FOUND" });
          const tables = state.storage.sql
            .exec("SELECT name FROM sqlite_master WHERE name LIKE 'database%'")
            .toArray();
          expect(tables).toEqual([]);
        });
      });
    });

    describe("chain", () => {
      it.each([
        [
          "part 0 points at a part",
          async () => [databasePart("a".repeat(64))],
          "BROKEN_PART_CHAIN",
        ],
        [
          "a part points at another part than the one before it",
          async () => {
            const [first, second] = await chainedParts({}, {});
            return [first!, second!, databasePart(await sha256Hex(first!), { seed: 9 })];
          },
          "BROKEN_PART_CHAIN",
        ],
        [
          "the user version goes down",
          () => chainedParts({ userVersion: 3 }, { userVersion: 2 }),
          "USER_VERSION_DECREASED",
        ],
      ])("rejects a replacement where %s, storing nothing", async (_name, partsOf, code) => {
        const parts = await partsOf();

        await inStore(async (instance) => {
          expect(await instance.replaceDatabase(SESSION, streamOf(...parts), null)).toEqual({
            success: false,
            code,
          });
          expect(await stored(instance)).toEqual({ success: false, code: "NOT_FOUND" });
        });
      });

      it("accepts a replacement whose user version stays the same or goes up", async () => {
        const parts = await chainedParts(
          { userVersion: 1 },
          { userVersion: 1 },
          { userVersion: 4 },
        );

        await inStore(async (instance) => {
          expect(await instance.replaceDatabase(SESSION, streamOf(...parts), null)).toMatchObject({
            success: true,
          });
        });
      });

      it("rejects an addition that doesn't point at the last part, adding nothing", async () => {
        const parts = await chainedParts({}, {});
        const last = await sha256Hex(parts[1]!);

        await inStore(async (instance) => {
          await instance.replaceDatabase(SESSION, streamOf(...parts), null);

          for (const previousHash of [await sha256Hex(parts[0]!), NO_PREVIOUS_PART])
            expect(
              await instance.appendDatabasePart(
                SESSION,
                streamOf(databasePart(previousHash)),
                last,
              ),
            ).toEqual({ success: false, code: "BROKEN_PART_CHAIN" });
          expect(await stored(instance)).toEqual(await storedAs(parts));
        });
      });

      it("adds a part whose user version is the last part's or higher, but not lower", async () => {
        const [first] = await chainedParts({ userVersion: 3 });
        const same = databasePart(await sha256Hex(first!), { userVersion: 3 });
        const lower = databasePart(await sha256Hex(same), { userVersion: 2 });
        const higher = databasePart(await sha256Hex(same), { userVersion: 4 });

        await inStore(async (instance) => {
          await instance.replaceDatabase(SESSION, streamOf(first!), null);
          const append = async (part: Uint8Array, after: Uint8Array<ArrayBuffer>) =>
            instance.appendDatabasePart(SESSION, streamOf(part), await sha256Hex(after));

          expect(await append(same, first!)).toMatchObject({ success: true });
          expect(await append(lower, same)).toEqual({
            success: false,
            code: "USER_VERSION_DECREASED",
          });
          expect(await append(higher, same)).toMatchObject({ success: true });
          expect(await stored(instance)).toEqual(await storedAs([first!, same, higher]));
        });
      });

      it("rejects adding two parts at once", async () => {
        const [first] = await chainedParts({});
        const second = databasePart(await sha256Hex(first!));
        const third = databasePart(await sha256Hex(second), { seed: 9 });

        await inStore(async (instance) => {
          await instance.replaceDatabase(SESSION, streamOf(first!), null);

          expect(
            await instance.appendDatabasePart(
              SESSION,
              streamOf(second, third),
              await sha256Hex(first!),
            ),
          ).toEqual({ success: false, code: "INVALID_PART_LENGTH" });
          expect(await stored(instance)).toEqual(await storedAs([first!]));
        });
      });
    });

    it.each([
      ["no magic", new Uint8Array(8), "MISSING_SPENDY_MAGIC"],
      ["version 1", databasePart(NO_PREVIOUS_PART).with(6, 0x01), "INVALID_VERSION_BYTE"],
      ["a cut-off part", databasePart(NO_PREVIOUS_PART).subarray(0, -1), "INVALID_PART_LENGTH"],
    ])("rejects a body with %s, storing nothing", async (_name, body, code) => {
      await inStore(async (instance) => {
        expect(await instance.replaceDatabase(SESSION, streamOf(body), null)).toEqual({
          success: false,
          code,
        });
        expect(await stored(instance)).toEqual({ success: false, code: "NOT_FOUND" });
      });
    });

    describe("session order", () => {
      // As many as the limit allows, newest first. Stored directly: logging in
      // for each would be slow.
      const sessions = Array.from({ length: env.MAX_SESSIONS_PER_USER }, () => crypto.randomUUID());
      // Where the older half starts: a session from here on is moved to the
      // front when used.
      const olderHalf = Math.ceil(env.MAX_SESSIONS_PER_USER / 2);

      /** Runs `fn` in alice's store, with `sessions` logged in. */
      function withSessions<R>(fn: (instance: UserStore, state: DurableObjectState) => Promise<R>) {
        return runInDurableObject(env.USER.getByName("alice"), (instance: UserStore, state) => {
          state.storage.kv.put("ACTIVE_SESSIONS", new Set(sessions));
          return fn(instance, state);
        });
      }

      const storedSessions = (state: DurableObjectState) => [
        ...(state.storage.kv.get<Set<string>>("ACTIVE_SESSIONS") ?? []),
      ];

      const part = databasePart(NO_PREVIOUS_PART);
      const uses: [string, (instance: UserStore, sessionId: string) => Promise<unknown>][] = [
        [
          "a replacement",
          (instance, sessionId) => instance.replaceDatabase(sessionId, streamOf(part), null),
        ],
        [
          "an addition",
          (instance, sessionId) =>
            instance.appendDatabasePart(sessionId, streamOf(part), NO_PREVIOUS_PART),
        ],
        ["a download", (instance, sessionId) => instance.downloadDatabase(sessionId, null)],
        ["a part's download", (instance, sessionId) => instance.downloadDatabasePart(sessionId, 0)],
      ];

      it.each(uses)("keeps the order on %s by a session in the newer half", async (_name, use) => {
        await withSessions(async (instance, state) => {
          await use(instance, sessions[olderHalf - 1]!);
          expect(storedSessions(state)).toEqual(sessions);
        });
      });

      it.each(uses)("moves a session in the older half to the front on %s", async (_name, use) => {
        await withSessions(async (instance, state) => {
          const used = sessions[olderHalf]!;
          await use(instance, used);
          expect(storedSessions(state)).toEqual([used, ...sessions.filter((id) => id !== used)]);
        });
      });

      it("keeps a used session over an unused newer one at the next login", async () => {
        await registerUser("alice");
        const used = sessions.at(-1)!;
        await withSessions((instance) => instance.downloadDatabase(used, null));

        await loginToken("alice");

        await runInDurableObject(env.USER.getByName("alice"), (_instance, state) => {
          expect(storedSessions(state)).toContain(used);
          expect(storedSessions(state)).not.toContain(sessions.at(-2));
        });
      });
    });
  });

  describe("logout", () => {
    it("does not write storage when an unknown user logs out", async () => {
      const stub = env.USER.getByName("nobody");

      await runInDurableObject(stub, async (instance, state) => {
        expect(await instance.logout(crypto.randomUUID())).toEqual({
          success: false,
          code: "UNAUTHORIZED",
        });
        expect(hasStorage(state)).toBe(false);
      });
    });

    it("does not accept a session evicted by the session limit", async () => {
      await registerUser("alice");
      const stub = env.USER.getByName("alice");
      // As many as the limit allows, newest first, so the next login is one
      // too many. Stored directly: logging in for each would be slow.
      const earlier = Array.from({ length: env.MAX_SESSIONS_PER_USER }, () => crypto.randomUUID());
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.kv.put("ACTIVE_SESSIONS", new Set(earlier));
      });

      const latest = atob(await loginToken("alice")).split(":")[1]!;

      await runInDurableObject(stub, async (instance) => {
        expect(await instance.logout(earlier.at(-1)!)).toEqual({
          success: false,
          code: "UNAUTHORIZED",
        });
        // Only the oldest.
        expect(await instance.logout(earlier.at(-2)!)).toEqual({ success: true });
        expect(await instance.logout(latest)).toEqual({ success: true });
      });
    });

    it("accepts sessions created by an earlier instance", async () => {
      const stub = env.USER.getByName("alice");
      const sessionId = crypto.randomUUID();
      // Stored, but never seen by the instance that answers below.
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.kv.put("ACTIVE_SESSIONS", new Set([sessionId]));
      });

      await runInDurableObject(stub, async (instance) => {
        expect(await instance.logout(sessionId)).toEqual({ success: true });
      });
    });
  });
});
