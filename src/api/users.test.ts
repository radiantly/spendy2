import { reset } from "cloudflare:test";
import * as opaque from "@serenity-kit/opaque";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PASSWORD, forwardFetchToWorker } from "../../worker/test/helpers.ts";
import { registerUser } from "./users.ts";

beforeAll(() => opaque.ready);
beforeEach(() => forwardFetchToWorker());
afterEach(async () => {
  vi.unstubAllGlobals();
  await reset();
});

describe("registerUser", () => {
  it("registers a new user", async () => {
    expect(await registerUser("alice", PASSWORD)).toEqual({ success: true });
  });

  it("reports a taken username", async () => {
    await registerUser("alice", PASSWORD);

    expect(await registerUser("alice", "a different password")).toEqual({
      success: false,
      code: "USER_ALREADY_EXISTS",
    });
  });

  it("reports a generic failure when the server rejects the request", async () => {
    // The server validates usernames too; the form normally catches this first.
    expect(await registerUser("Not Valid", PASSWORD)).toEqual({
      success: false,
      code: "REGISTRATION_FAILED",
    });
  });

  it("throws when the server can't be reached", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));

    await expect(registerUser("alice", PASSWORD)).rejects.toThrow("Failed to fetch");
  });
});
