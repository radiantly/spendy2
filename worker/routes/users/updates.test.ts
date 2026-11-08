import { env, exports } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import * as opaque from "@serenity-kit/opaque";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../databaseParts.ts";
import { DATABASE_UPDATES_CLOSE, tokenSchema } from "../../schemas.ts";
import { chainedParts, databasePart, loginToken, registerUser } from "../../test/helpers.ts";

beforeAll(() => opaque.ready);
afterEach(() => reset());

const { UNAUTHORIZED, AUTH_TIMEOUT } = DATABASE_UPDATES_CLOSE;

const updatesUrl = (username: string) => `http://localhost/api/users/${username}/database/updates`;

/**
 * A socket watching `username`'s database, with what it's been sent: each
 * message is waited for, and read once, in order.
 */
async function openSocket(username = "alice") {
  const response = await exports.default.fetch(updatesUrl(username), {
    headers: { Upgrade: "websocket" },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  const messages: string[] = [];
  let closed: { code: number; reason: string } | undefined;
  const waiting = new Set<() => void>();
  const wake = () => waiting.forEach((check) => check());
  ws.addEventListener("message", ({ data }) => {
    messages.push(data as string);
    wake();
  });
  ws.addEventListener("close", ({ code, reason }) => {
    closed = { code, reason };
    wake();
  });
  ws.accept();

  /** Resolves with what `get` finds, once it finds something. */
  const until = <T>(get: () => T | undefined) =>
    new Promise<T>((resolve) => {
      const check = () => {
        const found = get();
        if (found === undefined) return;
        waiting.delete(check);
        resolve(found);
      };
      waiting.add(check);
      check();
    });

  return {
    send: (message: string | ArrayBuffer) => ws.send(message),
    authenticate: (token: string) => ws.send(JSON.stringify({ token })),
    /** The next message it's sent, as it is. */
    nextRaw: () => until(() => messages.shift()),
    /** The next message it's sent, parsed. */
    next: async () => JSON.parse(await until(() => messages.shift())) as unknown,
    /** How it was closed, once it is. */
    closed: () => until(() => closed),
    /** Whether a message has come that hasn't been read. */
    hasUnread: () => messages.length > 0,
    close: () => ws.close(),
  };
}

/** A logged-in user's token. */
async function newUser(username = "alice") {
  await registerUser(username);
  return loginToken(username);
}

/** A socket of `username`'s, authenticated with `token`, past the message it's sent first. */
async function authenticatedSocket(token: string, username = "alice") {
  const socket = await openSocket(username);
  socket.authenticate(token);
  await socket.next();
  return socket;
}

function upload(method: "PUT" | "POST", token: string, body: Uint8Array, headers: HeadersInit) {
  return exports.default.fetch("http://localhost/api/users/me/database/parts", {
    method,
    headers: { Authorization: `Bearer ${token}`, ...headers },
    body,
  });
}

/** Stores a first database of one part, and returns the part. */
async function firstUpload(token: string, seed = 0) {
  const [part] = await chainedParts({ seed });
  expect((await upload("PUT", token, part!, { "If-None-Match": "*" })).status).toBe(204);
  return part!;
}

/** Adds a part after `last`, the last part stored, and returns the part. */
async function addPart(token: string, last: Uint8Array<ArrayBuffer>) {
  const part = databasePart(await sha256Hex(last));
  const response = await upload("POST", token, part, { "If-Match": `"${await sha256Hex(last)}"` });
  expect(response.status).toBe(204);
  return part;
}

function logOut(token: string) {
  return exports.default.fetch("http://localhost/api/auth/logout", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** A token for alice's session `sessionId`, which needn't be one she has. */
const tokenFor = (sessionId: string, username = "alice") =>
  tokenSchema.encode({ username, sessionId });

describe("GET /api/users/{username}/database/updates", () => {
  it("needs a WebSocket", async () => {
    const response = await exports.default.fetch(updatesUrl("alice"));

    expect(response.status).toBe(426);
    expect(await response.json()).toEqual({ error: "UPGRADE_REQUIRED" });
  });

  it("rejects a username that can't be one", async () => {
    const response = await exports.default.fetch(updatesUrl("Alice!"), {
      headers: { Upgrade: "websocket" },
    });

    expect(response.status).toBe(400);
  });

  it("sends the database's last part once the socket authenticates", async () => {
    const token = await newUser();
    const part = await firstUpload(token);
    const socket = await openSocket();

    socket.authenticate(token);

    expect(await socket.next()).toEqual({ sha256: await sha256Hex(part) });
  });

  it("sends null for the last part without a database", async () => {
    const token = await newUser();
    const socket = await openSocket();

    socket.authenticate(token);

    expect(await socket.next()).toEqual({ sha256: null });
  });

  it("sends nothing before the socket authenticates", async () => {
    const token = await newUser();
    const socket = await openSocket();
    const first = await firstUpload(token);
    const second = await addPart(token, first);

    socket.authenticate(token);

    // Only the last part as it is now, not each upload's before it.
    expect(await socket.next()).toEqual({ sha256: await sha256Hex(second) });
    expect(socket.hasUnread()).toBe(false);
  });

  it("tells every authenticated socket the last part after each upload", async () => {
    const token = await newUser();
    const other = await loginToken("alice");
    const sockets = [await authenticatedSocket(token), await authenticatedSocket(other)];

    const first = await firstUpload(token);
    for (const socket of sockets)
      expect(await socket.next()).toEqual({ sha256: await sha256Hex(first) });
    const second = await addPart(other, first);
    for (const socket of sockets)
      expect(await socket.next()).toEqual({ sha256: await sha256Hex(second) });
  });

  it("tells no one of an upload that's rejected", async () => {
    const token = await newUser();
    const socket = await authenticatedSocket(token);
    const first = await firstUpload(token);
    await socket.next();

    const [other] = await chainedParts({ seed: 9 });
    expect((await upload("PUT", token, other!, { "If-None-Match": "*" })).status).toBe(412);
    const ifMatch = { "If-Match": `"${await sha256Hex(first)}"` };
    expect((await upload("POST", token, databasePart("a".repeat(64)), ifMatch)).status).toBe(400);
    const second = await addPart(token, first);

    // The next it's told of is the upload that worked.
    expect(await socket.next()).toEqual({ sha256: await sha256Hex(second) });
  });

  it.each([
    ["isn't JSON", () => "{"],
    ["isn't an object", () => '"token"'],
    ["has no token", () => "{}"],
    ["has more than a token", () => JSON.stringify({ token: tokenFor(crypto.randomUUID()), x: 1 })],
    ["has a malformed token", () => JSON.stringify({ token: "not a token" })],
    [
      "has an unknown session's token",
      () => JSON.stringify({ token: tokenFor(crypto.randomUUID()) }),
    ],
    ["isn't text", () => new TextEncoder().encode("{}").slice().buffer],
  ])("closes a socket whose first message %s", async (_name, message) => {
    await newUser();
    const socket = await openSocket();

    socket.send(message());

    expect(await socket.closed()).toEqual({ code: UNAUTHORIZED, reason: "UNAUTHORIZED" });
  });

  it("closes a socket authenticating with another user's token", async () => {
    await newUser("alice");
    const bob = await newUser("bob");
    const socket = await openSocket("alice");

    socket.authenticate(bob);

    expect(await socket.closed()).toMatchObject({ code: UNAUTHORIZED });
  });

  it("closes a socket that doesn't authenticate in time", async () => {
    await newUser();
    const socket = await openSocket();

    expect(await socket.closed()).toEqual({ code: AUTH_TIMEOUT, reason: "AUTH_TIMEOUT" });
  });

  it("keeps an authenticated socket open past that time", async () => {
    const token = await newUser();
    const socket = await authenticatedSocket(token);
    await new Promise((resolve) => setTimeout(resolve, env.SOCKET_AUTH_TIMEOUT_SECONDS * 2000));

    const part = await firstUpload(token);

    expect(await socket.next()).toEqual({ sha256: await sha256Hex(part) });
  });

  it("closes the socket once its session logs out, and only its", async () => {
    const token = await newUser();
    const other = await loginToken("alice");
    const socket = await authenticatedSocket(token);
    const otherSocket = await authenticatedSocket(other);

    expect((await logOut(token)).status).toBe(204);

    expect(await socket.closed()).toEqual({ code: UNAUTHORIZED, reason: "UNAUTHORIZED" });
    const part = await firstUpload(other);
    expect(await otherSocket.next()).toEqual({ sha256: await sha256Hex(part) });
  });

  it("closes the socket once a new login pushes its session out", async () => {
    const token = await newUser();
    const socket = await authenticatedSocket(token);
    const sessionId = tokenSchema.decode(token).sessionId;
    // As many as the limit allows, its session the oldest, so the next login
    // is one too many. Stored directly: logging in for each would be slow.
    await runInDurableObject(env.USER.getByName("alice"), (_instance, state) => {
      const newer = Array.from({ length: env.MAX_SESSIONS_PER_USER - 1 }, () =>
        crypto.randomUUID(),
      );
      state.storage.kv.put("ACTIVE_SESSIONS", new Set([...newer, sessionId]));
    });

    await loginToken("alice");

    expect(await socket.closed()).toEqual({ code: UNAUTHORIZED, reason: "UNAUTHORIZED" });
  });

  it("closes the socket once the user is deleted for never saving a database", async () => {
    const token = await newUser();
    const socket = await authenticatedSocket(token);

    expect(await runDurableObjectAlarm(env.USER.getByName("alice"))).toBe(true);

    expect(await socket.closed()).toEqual({ code: UNAUTHORIZED, reason: "UNAUTHORIZED" });
  });

  it("keeps the socket open when the user is kept for having saved one", async () => {
    const token = await newUser();
    const socket = await authenticatedSocket(token);
    const first = await firstUpload(token);
    await socket.next();

    expect(await runDurableObjectAlarm(env.USER.getByName("alice"))).toBe(true);

    const second = await addPart(token, first);
    expect(await socket.next()).toEqual({ sha256: await sha256Hex(second) });
  });

  it("answers ping with pong", async () => {
    const token = await newUser();
    const socket = await authenticatedSocket(token);

    socket.send("ping");

    expect(await socket.nextRaw()).toBe("pong");
  });

  it("ignores what an authenticated socket sends", async () => {
    const token = await newUser();
    const socket = await authenticatedSocket(token);

    socket.send("{");
    socket.authenticate(tokenFor(crypto.randomUUID()));
    const part = await firstUpload(token);

    expect(await socket.next()).toEqual({ sha256: await sha256Hex(part) });
  });

  it("writes no storage for a socket to a user who doesn't exist", async () => {
    const socket = await openSocket("nobody");

    socket.authenticate(tokenFor(crypto.randomUUID(), "nobody"));

    await socket.closed();
    await runInDurableObject(env.USER.getByName("nobody"), (_instance, state) => {
      expect([...state.storage.kv.list()]).toEqual([]);
      expect(
        state.storage.sql
          .exec("SELECT name FROM sqlite_master WHERE name NOT LIKE '\\_cf%' ESCAPE '\\'")
          .toArray(),
      ).toEqual([]);
    });
  });
});
