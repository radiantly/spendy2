import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import * as opaque from "@serenity-kit/opaque";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DATABASE_BLOB_MAGIC, DATABASE_BLOB_VERSION, toSha256Schema } from "../schemas.ts";
import { loginToken, registerUser } from "../test/helpers.ts";
import { DATABASE_CHUNK_BYTES, type UserStore } from "./UserStore.ts";

const CLEANUP_DELAY_MS = env.USER_CLEANUP_DELAY_SECONDS * 1000;

beforeAll(() => opaque.ready);
afterEach(() => reset());

function startLoginRequest() {
  return opaque.client.startLogin({ password: "password" }).startLoginRequest;
}

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
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.kv.put("ACTIVE_SESSIONS", new Set([crypto.randomUUID()]));
        state.storage.kv.put("DATABASE_SHA256", "0".repeat(64));
      });

      expect(await runDurableObjectAlarm(stub)).toBe(true);

      await runInDurableObject(stub, (_instance, state) => {
        expect(getRegistrationRecord(state)).toBe("record");
        expect(state.storage.kv.get("DATABASE_SHA256")).toBe("0".repeat(64));
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
    /** The body of an upload. */
    const streamOf = (bytes: Uint8Array) => new Response(bytes).body!;

    const sha256Of = (bytes: Uint8Array) => toSha256Schema.decodeAsync(bytes.slice().buffer);

    /**
     * A database of `size` bytes, whose content differs all along it so
     * chunks out of order would show.
     */
    function blob(size: number) {
      const bytes = Uint8Array.from({ length: size }, (_, i) => i % 251);
      bytes.set([...DATABASE_BLOB_MAGIC, DATABASE_BLOB_VERSION]);
      return bytes;
    }

    it("does not write storage when an unknown user uploads or downloads", async () => {
      const stub = env.USER.getByName("nobody");

      await runInDurableObject(stub, async (instance, state) => {
        const unauthorized = { success: false, code: "UNAUTHORIZED" };
        expect(await instance.uploadDatabase(crypto.randomUUID(), streamOf(blob(8)), null)).toEqual(
          unauthorized,
        );
        expect(await instance.downloadDatabase(crypto.randomUUID(), null)).toEqual(unauthorized);

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

    it.each([
      ["less than a chunk", DATABASE_CHUNK_BYTES - 1],
      ["exactly a chunk", DATABASE_CHUNK_BYTES],
      ["just over a chunk", DATABASE_CHUNK_BYTES + 1],
      ["several chunks", 3 * DATABASE_CHUNK_BYTES + 12345],
    ])("returns a database of %s byte for byte, with its hash", async (_name, size) => {
      const body = blob(size);
      const sha256 = await sha256Of(body);

      await inStore(async (instance) => {
        expect(await instance.uploadDatabase(SESSION, streamOf(body), null)).toEqual({
          success: true,
          sha256,
        });
        const result = await instance.downloadDatabase(SESSION, null);

        if (!result.success || !result.modified) expect.unreachable(JSON.stringify(result));
        expect(result.sha256).toBe(sha256);
        // every() rather than toEqual: a failing toEqual would print megabytes
        const downloaded = new Uint8Array(result.body);
        expect(downloaded.length).toBe(size);
        expect(downloaded.every((byte, i) => byte === body[i])).toBe(true);
      });
    });

    it("stores a database in rows of at most a chunk, all replaced by the next", async () => {
      await inStore(async (instance, state) => {
        const rowSizes = () =>
          state.storage.sql
            .exec<{ size: number }>("SELECT length(data) AS size FROM database_chunks ORDER BY seq")
            .toArray()
            .map(({ size }) => size);

        const first = blob(2 * DATABASE_CHUNK_BYTES + 1);
        await instance.uploadDatabase(SESSION, streamOf(first), null);
        expect(rowSizes()).toEqual([DATABASE_CHUNK_BYTES, DATABASE_CHUNK_BYTES, 1]);

        await instance.uploadDatabase(SESSION, streamOf(blob(10)), await sha256Of(first));
        expect(rowSizes()).toEqual([10]);
      });
    });

    it("leaves the stored database as it was when the precondition fails", async () => {
      const body = blob(10);

      await inStore(async (instance) => {
        await instance.uploadDatabase(SESSION, streamOf(body), null);

        expect(await instance.uploadDatabase(SESSION, streamOf(blob(20)), "9".repeat(64))).toEqual({
          success: false,
          code: "PRECONDITION_FAILED",
        });
        expect(await instance.downloadDatabase(SESSION, null)).toEqual({
          success: true,
          modified: true,
          body: body.buffer,
          sha256: await sha256Of(body),
        });
      });
    });

    it.each([
      ["no magic", new Uint8Array(8), "MISSING_SPENDY_MAGIC"],
      ["another version", new Uint8Array([...DATABASE_BLOB_MAGIC, 2, 0]), "INVALID_VERSION_BYTE"],
    ])("rejects a body with %s, storing nothing", async (_name, body, code) => {
      await inStore(async (instance) => {
        expect(await instance.uploadDatabase(SESSION, streamOf(body), null)).toEqual({
          success: false,
          code,
        });
        expect(await instance.downloadDatabase(SESSION, null)).toEqual({
          success: false,
          code: "NOT_FOUND",
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
      // As many as the limit allows, oldest first, so the next login is one
      // too many. Stored directly: logging in for each would be slow.
      const earlier = Array.from({ length: env.MAX_SESSIONS_PER_USER }, () => crypto.randomUUID());
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.kv.put("ACTIVE_SESSIONS", new Set(earlier));
      });

      const latest = atob(await loginToken("alice")).split(":")[1]!;

      await runInDurableObject(stub, async (instance) => {
        expect(await instance.logout(earlier[0]!)).toEqual({
          success: false,
          code: "UNAUTHORIZED",
        });
        // Only the oldest.
        expect(await instance.logout(earlier[1]!)).toEqual({ success: true });
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
