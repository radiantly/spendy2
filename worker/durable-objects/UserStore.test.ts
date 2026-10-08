import { env } from "cloudflare:workers";
import {
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import * as opaque from "@serenity-kit/opaque";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const CLEANUP_DELAY_MS = env.USER_CLEANUP_DELAY_SECONDS * 1000;

beforeAll(() => opaque.ready);
afterEach(() => reset());

function startLoginRequest() {
  return opaque.client.startLogin({ password: "password" }).startLoginRequest;
}

function getRegistrationRecord(state: DurableObjectState) {
  return state.storage.sql
    .exec<{ record: string }>(`SELECT record FROM registration_record;`)
    .toArray()[0]?.record;
}

/** Whether any table other than the runtime's internal ones exists. */
function hasUserTables(state: DurableObjectState) {
  return (
    state.storage.sql
      .exec(
        `
        SELECT 1 FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE '\\_cf%' ESCAPE '\\'
          AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\';`,
      )
      .toArray().length > 0
  );
}

describe("UserStore", () => {
  it("does not create storage before the first write", async () => {
    const stub = env.USER.getByName("alice");

    await runInDurableObject(stub, (_instance, state) => {
      expect(hasUserTables(state)).toBe(false);
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

  it("accepts an identical registration record again", async () => {
    const stub = env.USER.getByName("alice");
    await stub.registerNewUser("record");

    expect(await stub.registerNewUser("record")).toEqual({ success: true });
  });

  // TODO: the alarm is implemented in a later phase
  describe.skip("alarm", () => {
    it("deletes all storage when the alarm fires before a login", async () => {
      const stub = env.USER.getByName("alice");
      await stub.registerNewUser("record");

      expect(await runDurableObjectAlarm(stub)).toBe(true);

      await runInDurableObject(stub, (_instance, state) => {
        expect(hasUserTables(state)).toBe(false);
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

    it("keeps the user when the alarm fires after a login", async () => {
      const stub = env.USER.getByName("alice");
      await stub.registerNewUser("record");
      await runInDurableObject(stub, (_instance, state) => {
        state.storage.sql.exec(`
          CREATE TABLE IF NOT EXISTS sessions (
            id          TEXT NOT NULL PRIMARY KEY,
            created_at  INTEGER NOT NULL
          );`);
        state.storage.sql.exec(
          `INSERT INTO sessions (id, created_at) VALUES (?, ?);`,
          crypto.randomUUID(),
          Date.now(),
        );
      });

      expect(await runDurableObjectAlarm(stub)).toBe(true);

      await runInDurableObject(stub, (_instance, state) => {
        expect(getRegistrationRecord(state)).toBe("record");
      });
    });
  });

  it("does not write storage when an unknown user starts a login", async () => {
    const stub = env.USER.getByName("nobody");

    await runInDurableObject(stub, async (instance, state) => {
      const result = await instance.startLoginRatelimited(startLoginRequest());

      expect(result.success).toBe(true);
      expect(hasUserTables(state)).toBe(false);
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
      await expect(
        instance.startLoginRatelimited(startLoginRequest()),
      ).rejects.toThrow("UserStore must be addressed by name");
      expect(hasUserTables(state)).toBe(false);
    });
  });
});
