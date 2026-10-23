import { env, exports } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import * as opaque from "@serenity-kit/opaque";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PASSWORD, login, loginToken, post, registerUser, startLogin } from "../test/helpers.ts";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeAll(() => opaque.ready);
beforeEach(() => {
  // time only moves when a test advances it
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await reset();
});

function advance(ms: number) {
  vi.setSystemTime(Date.now() + ms);
}

/**
 * Fixes the random part of the login delay. 0 gives the shortest delay (1s),
 * 1 gives the longest one for the current number of attempts.
 */
function setRandom(value: number) {
  vi.spyOn(Math, "random").mockReturnValue(value);
}

/** The longest delay after the given number of attempts. */
function maxDelayMs(attempts: number) {
  return Math.min(2 ** attempts, env.LOGIN_BACKOFF_MAX_SECONDS) * 1000;
}

async function startLoginStatus(username: string) {
  return (await startLogin(username)).response.status;
}

/** Creates a well-formed finishLoginRequest that belongs to a different login. */
async function foreignFinishLoginRequest() {
  await registerUser("mallory");
  const { response, clientLoginState } = await startLogin("mallory");
  const { loginResponse } = await response.json<{ loginResponse: string }>();
  return opaque.client.finishLogin({
    clientLoginState,
    loginResponse,
    password: PASSWORD,
  })!.finishLoginRequest;
}

function decodeToken(token: string) {
  const [username, sessionId] = atob(token).split(":");
  return { username, sessionId };
}

function getSessionIds(username: string) {
  return runInDurableObject(env.USER.getByName(username), (_instance, state) => [
    ...(state.storage.kv.get<Set<string>>("ACTIVE_SESSIONS") ?? []),
  ]);
}

async function startRegistration(username: string) {
  const { clientRegistrationState, registrationRequest } = opaque.client.startRegistration({
    password: PASSWORD,
  });

  const response = await post("/auth/register/start", { username, registrationRequest });
  expect(response.status).toBe(200);
  const { registrationResponse } = await response.json<{
    registrationResponse: string;
  }>();

  return { clientRegistrationState, registrationResponse };
}

async function createRegistrationRecord(username: string) {
  const { clientRegistrationState, registrationResponse } = await startRegistration(username);

  const { registrationRecord } = opaque.client.finishRegistration({
    clientRegistrationState,
    registrationResponse,
    password: PASSWORD,
  });

  return registrationRecord;
}

describe("POST /api/auth/register/start", () => {
  describe("validation", () => {
    it.each(["Alice", "ab", "a".repeat(33), "al ice", "al-ice"])(
      "rejects username %j",
      async (username) => {
        const response = await post("/auth/register/start", {
          username,
          registrationRequest: "x",
        });
        expect(response.status).toBe(400);
      },
    );

    it("rejects a registrationRecord field", async () => {
      const response = await post("/auth/register/start", {
        username: "alice",
        registrationRequest: "x",
        registrationRecord: "x",
      });
      expect(response.status).toBe(400);
    });

    it("rejects unknown fields", async () => {
      const response = await post("/auth/register/start", {
        username: "alice",
        registrationRequest: "x",
        extra: true,
      });
      expect(response.status).toBe(400);
    });

    it("rejects an oversized registration request", async () => {
      const response = await post("/auth/register/start", {
        username: "alice",
        registrationRequest: "x".repeat(4097),
      });
      expect(response.status).toBe(400);
    });

    it("rejects a malformed registration request", async () => {
      const response = await post("/auth/register/start", {
        username: "alice",
        registrationRequest: "not-a-registration-request",
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "INVALID_REGISTRATION_REQUEST" });
    });
  });

  it("returns a registration response", async () => {
    const { registrationResponse } = await startRegistration("alice");
    expect(registrationResponse).toEqual(expect.any(String));
  });
});

describe("POST /api/auth/register/finish", () => {
  describe("validation", () => {
    it.each(["Alice", "ab", "a".repeat(33), "al ice", "al-ice"])(
      "rejects username %j",
      async (username) => {
        const response = await post("/auth/register/finish", {
          username,
          registrationRecord: "x",
        });
        expect(response.status).toBe(400);
      },
    );

    it("rejects a registrationRequest field", async () => {
      const response = await post("/auth/register/finish", {
        username: "alice",
        registrationRequest: "x",
        registrationRecord: "x",
      });
      expect(response.status).toBe(400);
    });

    it("rejects an oversized registration record", async () => {
      const response = await post("/auth/register/finish", {
        username: "alice",
        registrationRecord: "x".repeat(4097),
      });
      expect(response.status).toBe(400);
    });
  });

  it("creates the user", async () => {
    const registrationRecord = await createRegistrationRecord("alice");

    const response = await post("/auth/register/finish", {
      username: "alice",
      registrationRecord,
    });
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect((await login("alice")).status).toBe(200);
  });

  it("returns 409 when the user already exists", async () => {
    const registrationRecord = await createRegistrationRecord("alice");
    await post("/auth/register/finish", { username: "alice", registrationRecord });

    const response = await post("/auth/register/finish", {
      username: "alice",
      registrationRecord: await createRegistrationRecord("alice"),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "USER_ALREADY_EXISTS" });
  });

  it("returns 409 for the same registration record again", async () => {
    const registrationRecord = await createRegistrationRecord("alice");
    await post("/auth/register/finish", { username: "alice", registrationRecord });

    const response = await post("/auth/register/finish", {
      username: "alice",
      registrationRecord,
    });
    expect(response.status).toBe(409);
  });
});

describe("POST /api/auth/login/start", () => {
  describe("validation", () => {
    it.each(["Alice", "ab", "a".repeat(33), "al ice", "al-ice"])(
      "rejects username %j",
      async (username) => {
        const response = await post("/auth/login/start", {
          username,
          startLoginRequest: "x",
        });
        expect(response.status).toBe(400);
      },
    );

    it("rejects a body that isn't JSON", async () => {
      const response = await exports.default.fetch("http://localhost/api/auth/login/start", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ username: "alice", startLoginRequest: "x" }),
      });
      expect(response.status).toBe(415);
    });

    it("rejects a finishLoginRequest field", async () => {
      const response = await post("/auth/login/start", {
        username: "alice",
        startLoginRequest: "x",
        finishLoginRequest: "x",
      });
      expect(response.status).toBe(400);
    });

    it("rejects unknown fields", async () => {
      const response = await post("/auth/login/start", {
        username: "alice",
        startLoginRequest: "x",
        extra: true,
      });
      expect(response.status).toBe(400);
    });

    it("rejects an oversized start request", async () => {
      const response = await post("/auth/login/start", {
        username: "alice",
        startLoginRequest: "x".repeat(4097),
      });
      expect(response.status).toBe(400);
    });

    it("rejects a malformed login start request", async () => {
      await registerUser("alice");
      const response = await post("/auth/login/start", {
        username: "alice",
        startLoginRequest: "not-a-login-request",
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "INVALID_REQUEST" });
    });

    it("does not rate limit after a malformed login start request", async () => {
      await registerUser("alice");
      await post("/auth/login/start", {
        username: "alice",
        startLoginRequest: "not-a-login-request",
      });

      expect(await startLoginStatus("alice")).toBe(200);
    });
  });

  it("returns a login response", async () => {
    await registerUser("alice");
    const { response } = await startLogin("alice");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      loginResponse: expect.any(String),
    });
  });

  describe("rate limit", () => {
    it("rejects an immediate second start without revealing the delay", async () => {
      await registerUser("alice");
      await startLogin("alice");

      const { response } = await startLogin("alice");
      expect(response.status).toBe(429);
      expect(response.headers.has("Retry-After")).toBe(false);
      expect(await response.json()).toEqual({ error: "RATE_LIMITED" });
    });

    it("accepts a start once the delay has passed", async () => {
      await registerUser("alice");
      await startLogin("alice");
      advance(env.LOGIN_BACKOFF_MAX_SECONDS * 1000);

      expect(await startLoginStatus("alice")).toBe(200);
    });

    it("delays the next start by at least 1 second", async () => {
      setRandom(0);
      await registerUser("alice");
      await startLogin("alice");

      advance(999);
      expect(await startLoginStatus("alice")).toBe(429);
      advance(1);
      expect(await startLoginStatus("alice")).toBe(200);
    });

    it.each([1, 2, 3, 4, 5, 6])(
      "delays the next start by at most the backoff cap after %i attempts",
      async (attempts) => {
        setRandom(1);
        await registerUser("alice");
        expect(await startLoginStatus("alice")).toBe(200);
        for (let i = 1; i < attempts; i++) {
          advance(maxDelayMs(i));
          expect(await startLoginStatus("alice")).toBe(200);
        }

        advance(maxDelayMs(attempts) - 1);
        expect(await startLoginStatus("alice")).toBe(429);
        advance(1);
        expect(await startLoginStatus("alice")).toBe(200);
      },
    );

    it("does not count rejected starts as attempts", async () => {
      setRandom(1);
      await registerUser("alice");
      await startLogin("alice");
      advance(1000);
      expect(await startLoginStatus("alice")).toBe(429);
      advance(maxDelayMs(1) - 1000);
      expect(await startLoginStatus("alice")).toBe(200);

      // second attempt: the delay would be maxDelayMs(3) if the rejected
      // start had counted
      advance(maxDelayMs(2));
      expect(await startLoginStatus("alice")).toBe(200);
    });

    it("resets attempts after a successful login", async () => {
      setRandom(1);
      await registerUser("alice");
      await startLogin("alice");
      advance(maxDelayMs(1));
      await startLogin("alice");
      advance(maxDelayMs(2));

      expect((await login("alice")).status).toBe(200);

      expect(await startLoginStatus("alice")).toBe(200);
      advance(maxDelayMs(1) - 1);
      expect(await startLoginStatus("alice")).toBe(429);
      advance(1);
      expect(await startLoginStatus("alice")).toBe(200);
    });

    it("rate limits unknown users the same as real users", async () => {
      setRandom(1);
      await registerUser("alice");

      async function statuses(username: string) {
        const result = [await startLoginStatus(username)];
        for (const ms of [1000, maxDelayMs(1) - 1000, maxDelayMs(2) - 1, 1]) {
          advance(ms);
          result.push(await startLoginStatus(username));
        }
        return result;
      }

      const expected = [200, 429, 200, 429, 200];
      expect(await statuses("alice")).toEqual(expected);
      expect(await statuses("nobody")).toEqual(expected);
    });
  });
});

describe("POST /api/auth/login/finish", () => {
  describe("validation", () => {
    it.each(["Alice", "ab", "a".repeat(33), "al ice", "al-ice"])(
      "rejects username %j",
      async (username) => {
        const response = await post("/auth/login/finish", {
          username,
          finishLoginRequest: "x",
        });
        expect(response.status).toBe(400);
      },
    );

    it("rejects a startLoginRequest field", async () => {
      const response = await post("/auth/login/finish", {
        username: "alice",
        startLoginRequest: "x",
        finishLoginRequest: "x",
      });
      expect(response.status).toBe(400);
    });

    it("rejects an oversized finish request", async () => {
      const response = await post("/auth/login/finish", {
        username: "alice",
        finishLoginRequest: "x".repeat(4097),
      });
      expect(response.status).toBe(400);
    });
  });

  it("returns a token for a new session", async () => {
    await registerUser("alice");
    const response = await login("alice");

    expect(response.status).toBe(200);
    const { token } = await response.json<{ token: string }>();
    const { username, sessionId } = decodeToken(token);
    expect(username).toBe("alice");
    expect(sessionId).toMatch(UUID_REGEX);
    expect(await getSessionIds("alice")).toEqual([sessionId]);
  });

  it("rejects a wrong password", async () => {
    await registerUser("alice");
    const { response, clientLoginState } = await startLogin("alice", "wrong password");
    const { loginResponse } = await response.json<{
      loginResponse: string;
    }>();

    // the client detects the wrong password itself, so it never gets a
    // finishLoginRequest to send
    expect(
      opaque.client.finishLogin({
        clientLoginState,
        loginResponse,
        password: "wrong password",
      }),
    ).toBeUndefined();
  });

  it("rejects a finish request that belongs to another login", async () => {
    const finishLoginRequest = await foreignFinishLoginRequest();
    await registerUser("alice");
    await startLogin("alice");

    const response = await post("/auth/login/finish", {
      username: "alice",
      finishLoginRequest,
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "INVALID_LOGIN" });
    expect(await getSessionIds("alice")).toEqual([]);
  });

  it("rejects a malformed finish request", async () => {
    await registerUser("alice");
    await startLogin("alice");

    const response = await post("/auth/login/finish", {
      username: "alice",
      finishLoginRequest: "not-a-finish-request",
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "INVALID_LOGIN" });
  });

  it("rejects a finish without a start", async () => {
    const finishLoginRequest = await foreignFinishLoginRequest();
    await registerUser("alice");

    const response = await post("/auth/login/finish", {
      username: "alice",
      finishLoginRequest,
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: "INVALID_LOGIN_OR_TIMED_OUT",
    });
  });

  it("rejects a finish for an unknown user", async () => {
    const finishLoginRequest = await foreignFinishLoginRequest();
    await startLogin("nobody");

    const response = await post("/auth/login/finish", {
      username: "nobody",
      finishLoginRequest,
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "INVALID_LOGIN" });
  });

  it("allows a login state to be used only once", async () => {
    await registerUser("alice");
    const { response, clientLoginState } = await startLogin("alice");
    const { loginResponse } = await response.json<{
      loginResponse: string;
    }>();
    const { finishLoginRequest } = opaque.client.finishLogin({
      clientLoginState,
      loginResponse,
      password: PASSWORD,
    })!;

    await post("/auth/login/finish", {
      username: "alice",
      finishLoginRequest: "not-a-finish-request",
    });
    const replay = await post("/auth/login/finish", {
      username: "alice",
      finishLoginRequest,
    });
    expect(replay.status).toBe(401);
  });

  it("evicts the oldest session beyond the session limit", async () => {
    await registerUser("alice");

    const sessionIds: string[] = [];
    for (let i = 0; i <= env.MAX_SESSIONS_PER_USER; i++) {
      const response = await login("alice");
      expect(response.status).toBe(200);
      const { token } = await response.json<{ token: string }>();
      sessionIds.push(decodeToken(token).sessionId);
    }

    const stored = await getSessionIds("alice");
    expect(stored).toHaveLength(env.MAX_SESSIONS_PER_USER);
    expect(stored).not.toContain(sessionIds[0]);
    expect(stored).toEqual(expect.arrayContaining(sessionIds.slice(1)));
  });
});

function postLogout(authorization?: string) {
  return exports.default.fetch("http://localhost/api/auth/logout", {
    method: "POST",
    headers: authorization === undefined ? {} : { Authorization: authorization },
  });
}

describe("POST /api/auth/logout", () => {
  it("logs out the current session", async () => {
    await registerUser("alice");
    const token = await loginToken("alice");

    const response = await postLogout(`Bearer ${token}`);
    expect(response.status).toBe(204);
    expect(await getSessionIds("alice")).toEqual([]);

    const again = await postLogout(`Bearer ${token}`);
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ error: "UNAUTHORIZED" });
  });

  it("only removes the current session", async () => {
    await registerUser("alice");
    const first = await loginToken("alice");
    const second = await loginToken("alice");

    expect((await postLogout(`Bearer ${first}`)).status).toBe(204);
    expect(await getSessionIds("alice")).toEqual([decodeToken(second).sessionId]);
    expect((await postLogout(`Bearer ${second}`)).status).toBe(204);
  });

  it("allows logging in again after logging out", async () => {
    await registerUser("alice");
    const token = await loginToken("alice");
    await postLogout(`Bearer ${token}`);

    const newToken = await loginToken("alice");
    expect(newToken).not.toBe(token);
    expect((await postLogout(`Bearer ${newToken}`)).status).toBe(204);
  });

  it("rejects a request without an Authorization header", async () => {
    const response = await postLogout();
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toMatch(/^Bearer/);
    expect(await response.json()).toEqual({ error: "UNAUTHORIZED" });
  });

  it.each([
    ["a non-Bearer scheme", `Basic ${btoa("alice:password")}`],
    ["an empty bearer token", "Bearer "],
    ["a bearer token with invalid characters", "Bearer not a token"],
  ])("rejects %s", async (_name, authorization) => {
    const response = await postLogout(authorization);
    expect(response.status).toBe(400);
  });

  it.each([
    ["not base64", "a"],
    ["without a separator", btoa("alice")],
    ["with an uppercase username", btoa(`Alice:${crypto.randomUUID()}`)],
    ["with a short username", btoa(`ab:${crypto.randomUUID()}`)],
    ["with a session id that is not a uuid", btoa("alice:not-a-uuid")],
  ])("rejects a token %s", async (_name, token) => {
    const response = await postLogout(`Bearer ${token}`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "UNAUTHORIZED" });
  });

  it("rejects an unknown session of a registered user", async () => {
    await registerUser("alice");
    await loginToken("alice");

    const token = btoa(`alice:${crypto.randomUUID()}`);
    const response = await postLogout(`Bearer ${token}`);
    expect(response.status).toBe(401);
    expect(await getSessionIds("alice")).toHaveLength(1);
  });

  it("rejects a session of another user", async () => {
    await registerUser("alice");
    await registerUser("bob");
    const { sessionId } = decodeToken(await loginToken("alice"));

    const response = await postLogout(`Bearer ${btoa(`bob:${sessionId}`)}`);
    expect(response.status).toBe(401);
    expect(await getSessionIds("alice")).toEqual([sessionId]);
  });
});
