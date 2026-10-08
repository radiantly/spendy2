import { env, exports } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import * as opaque from "@serenity-kit/opaque";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const PASSWORD = "correct horse battery staple";
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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

function post(path: string, body: unknown) {
  return exports.default.fetch(`http://localhost/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function registerUser(username: string, password = PASSWORD) {
  const { clientRegistrationState, registrationRequest } =
    opaque.client.startRegistration({ password });
  const startResponse = await post("/users", { username, registrationRequest });
  const { registrationResponse } = await startResponse.json<{
    registrationResponse: string;
  }>();
  const { registrationRecord } = opaque.client.finishRegistration({
    clientRegistrationState,
    registrationResponse,
    password,
  });
  const finishResponse = await post("/users", {
    username,
    registrationRecord,
  });
  expect(finishResponse.status).toBe(201);
}

async function startLogin(username: string, password = PASSWORD) {
  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({
    password,
  });
  const response = await post("/auth/login", { username, startLoginRequest });
  return { response, clientLoginState };
}

async function startLoginStatus(username: string) {
  return (await startLogin(username)).response.status;
}

/** Runs a full login and returns the finish response. */
async function login(username: string, password = PASSWORD) {
  const { response, clientLoginState } = await startLogin(username, password);
  expect(response.status).toBe(200);
  const { loginResponse } = await response.json<{ loginResponse: string }>();

  const result = opaque.client.finishLogin({
    clientLoginState,
    loginResponse,
    password,
  });
  expect(result).toBeDefined();

  return post("/auth/login", {
    username,
    finishLoginRequest: result!.finishLoginRequest,
  });
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
  return runInDurableObject(
    env.USER.getByName(username),
    (_instance, state) => {
      const tableExists =
        state.storage.sql
          .exec(
            `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions';`,
          )
          .toArray().length > 0;
      if (!tableExists) return [];

      return state.storage.sql
        .exec<{ id: string }>(`SELECT id FROM sessions;`)
        .toArray()
        .map((row) => row.id);
    },
  );
}

describe("POST /api/auth/login", () => {
  describe("validation", () => {
    it.each(["Alice", "ab", "a".repeat(33), "al ice", "al-ice"])(
      "rejects username %j",
      async (username) => {
        const response = await post("/auth/login", {
          username,
          startLoginRequest: "x",
        });
        expect(response.status).toBe(400);
      },
    );

    it("rejects a body with both start and finish fields", async () => {
      const response = await post("/auth/login", {
        username: "alice",
        startLoginRequest: "x",
        finishLoginRequest: "x",
      });
      expect(response.status).toBe(400);
    });

    it("rejects unknown fields", async () => {
      const response = await post("/auth/login", {
        username: "alice",
        startLoginRequest: "x",
        extra: true,
      });
      expect(response.status).toBe(400);
    });

    it("rejects oversized fields", async () => {
      const response = await post("/auth/login", {
        username: "alice",
        finishLoginRequest: "x".repeat(4097),
      });
      expect(response.status).toBe(400);
    });

    it("rejects a malformed login start request", async () => {
      await registerUser("alice");
      const response = await post("/auth/login", {
        username: "alice",
        startLoginRequest: "not-a-login-request",
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "INVALID_REQUEST" });
    });

    it("does not rate limit after a malformed login start request", async () => {
      await registerUser("alice");
      await post("/auth/login", {
        username: "alice",
        startLoginRequest: "not-a-login-request",
      });

      expect(await startLoginStatus("alice")).toBe(200);
    });
  });

  describe("login start", () => {
    it("returns a login response", async () => {
      await registerUser("alice");
      const { response } = await startLogin("alice");

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        loginResponse: expect.any(String),
      });
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

  describe("login finish", () => {
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
      const { response, clientLoginState } = await startLogin(
        "alice",
        "wrong password",
      );
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

      const response = await post("/auth/login", {
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

      const response = await post("/auth/login", {
        username: "alice",
        finishLoginRequest: "not-a-finish-request",
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "INVALID_LOGIN" });
    });

    it("rejects a finish without a start", async () => {
      const finishLoginRequest = await foreignFinishLoginRequest();
      await registerUser("alice");

      const response = await post("/auth/login", {
        username: "alice",
        finishLoginRequest,
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "TIMED_OUT" });
    });

    it("rejects a finish for an unknown user", async () => {
      const finishLoginRequest = await foreignFinishLoginRequest();
      await startLogin("nobody");

      const response = await post("/auth/login", {
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

      await post("/auth/login", {
        username: "alice",
        finishLoginRequest: "not-a-finish-request",
      });
      const replay = await post("/auth/login", {
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
});
