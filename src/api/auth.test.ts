import { reset } from "cloudflare:test";
import * as opaque from "@serenity-kit/opaque";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PASSWORD, forwardFetchToWorker } from "../../worker/test/helpers.ts";
import { tokenSchema } from "../../worker/schemas.ts";
import { registerUser } from "./users.ts";
import { loginUser } from "./auth.ts";

beforeAll(() => opaque.ready);
beforeEach(async () => {
  // Time only moves when a test advances it, so the login backoff is deterministic.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
  forwardFetchToWorker();
  await registerUser("alice", PASSWORD);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await reset();
});

describe("loginUser", () => {
  it("returns a token for the user and the export key", async () => {
    const result = await loginUser("alice", PASSWORD);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(tokenSchema.decode(result.token).username).toBe("alice");
    expect(result.exportKey).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("returns the same export key on every login", async () => {
    const first = await loginUser("alice", PASSWORD);
    const second = await loginUser("alice", PASSWORD);

    expect(first.success && second.success).toBe(true);
    if (!first.success || !second.success) return;
    expect(second.exportKey).toBe(first.exportKey);
    expect(second.token).not.toBe(first.token);
  });

  it("reports a wrong password as an invalid login", async () => {
    expect(await loginUser("alice", "wrong password")).toEqual({
      success: false,
      code: "INVALID_LOGIN",
    });
  });

  it("reports an unknown user the same way as a wrong password", async () => {
    expect(await loginUser("nobody", PASSWORD)).toEqual({
      success: false,
      code: "INVALID_LOGIN",
    });
  });

  it("reports an immediate retry after a failed attempt as rate limited", async () => {
    await loginUser("alice", "wrong password");

    expect(await loginUser("alice", PASSWORD)).toEqual({
      success: false,
      code: "RATE_LIMITED",
    });
  });

  it("allows a retry once the backoff has passed", async () => {
    await loginUser("alice", "wrong password");
    // After one attempt the delay is at most 2s.
    vi.setSystemTime(Date.now() + 2000);

    expect((await loginUser("alice", PASSWORD)).success).toBe(true);
  });

  it("reports a generic failure when the server rejects the request", async () => {
    expect(await loginUser("Not Valid", PASSWORD)).toEqual({
      success: false,
      code: "LOGIN_FAILED",
    });
  });

  it("throws when the server can't be reached", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));

    await expect(loginUser("alice", PASSWORD)).rejects.toThrow("Failed to fetch");
  });
});
