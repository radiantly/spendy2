import { env } from "cloudflare:workers";
import {
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

const DAY_MS = 1000 * 60 * 60 * 24;

afterEach(() => reset());

function getKv(state: DurableObjectState, key: string) {
  return state.storage.sql
    .exec<{ value: string }>(`SELECT value FROM kv WHERE key = ?;`, key)
    .toArray()[0]?.value;
}

function hasKvTable(state: DurableObjectState) {
  return (
    state.storage.sql
      .exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kv';`)
      .toArray().length > 0
  );
}

describe("UserStore", () => {
  it("does not create storage before the first write", async () => {
    const stub = env.USER.getByName("alice");

    await runInDurableObject(stub, (_instance, state) => {
      expect(hasKvTable(state)).toBe(false);
    });
  });

  it("stores the registration record and schedules expiry in 24h", async () => {
    const stub = env.USER.getByName("alice");

    await runInDurableObject(stub, async (instance, state) => {
      const before = Date.now();
      await instance.registerNewUser("record");

      expect(getKv(state, "RegistrationRecord")).toBe("record");
      const alarm = await state.storage.getAlarm();
      expect(alarm).toBeGreaterThanOrEqual(before + DAY_MS);
      expect(alarm).toBeLessThanOrEqual(Date.now() + DAY_MS);
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
      expect(getKv(state, "RegistrationRecord")).toBe("first");
    });
  });

  it("deletes all storage when the alarm fires before a login", async () => {
    const stub = env.USER.getByName("alice");
    await stub.registerNewUser("record");

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(stub, (_instance, state) => {
      expect(hasKvTable(state)).toBe(false);
    });
  });

  it("allows registering again after the user was deleted", async () => {
    const stub = env.USER.getByName("alice");
    await stub.registerNewUser("first");
    await runDurableObjectAlarm(stub);

    await stub.registerNewUser("second");

    await runInDurableObject(stub, (_instance, state) => {
      expect(getKv(state, "RegistrationRecord")).toBe("second");
    });
  });

  it("keeps the user when the alarm fires after a login", async () => {
    const stub = env.USER.getByName("alice");
    await stub.registerNewUser("record");
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO kv (key, value) VALUES ('LastLogin', ?);`,
        String(Date.now()),
      );
    });

    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await runInDurableObject(stub, (_instance, state) => {
      expect(getKv(state, "RegistrationRecord")).toBe("record");
    });
  });
});
