import { reset } from "cloudflare:test";
import * as opaque from "@serenity-kit/opaque";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../worker/databaseParts.ts";
import { tokenSchema } from "../../worker/schemas.ts";
import {
  chainedParts,
  databasePart,
  forwardFetchToWorker,
  forwardWebSocketsToWorker,
  loginToken,
  registerUser,
} from "../../worker/test/helpers.ts";
import { logoutUser } from "./auth.ts";
import { appendDatabasePart, replaceDatabase } from "./database.ts";
import { PING_INTERVAL, RETRY_DELAYS, watchDatabase, type LatestPart } from "./databaseUpdates.ts";

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.unstubAllGlobals();
});

/** Watches alice's database with `token`, keeping what it hears. */
function watching(token: string) {
  const heard: (LatestPart | null)[] = [];
  const onSessionEnded = vi.fn();
  stop = watchDatabase("alice", token, {
    onLatestPart: (latestPart) => heard.push(latestPart),
    onSessionEnded,
  });
  return { heard, onSessionEnded };
}

describe("watchDatabase, with the server", () => {
  let token: string;

  beforeAll(() => opaque.ready);
  beforeEach(async () => {
    forwardFetchToWorker();
    forwardWebSocketsToWorker();
    await registerUser("alice");
    token = await loginToken("alice");
  });
  afterEach(() => reset());

  it("is told the last part on connecting, and after each upload", async () => {
    const { heard } = watching(token);
    await expect.poll(() => heard).toEqual([null]);

    const [first] = await chainedParts({});
    await replaceDatabase(token, first!, { ifNoneMatch: true });
    const second = databasePart(await sha256Hex(first!));
    await appendDatabasePart(token, second);

    await expect
      .poll(() => heard)
      .toEqual([
        null,
        { index: 0, hash: await sha256Hex(first!) },
        { index: 1, hash: await sha256Hex(second) },
      ]);
  });

  it("says the session ended once it's logged out", async () => {
    const { heard, onSessionEnded } = watching(token);
    await expect.poll(() => heard).toHaveLength(1);

    await logoutUser(token);

    await expect.poll(() => onSessionEnded.mock.calls).toHaveLength(1);
  });

  it("says the session ended for a token the server doesn't accept", async () => {
    const unknown = tokenSchema.encode({ username: "alice", sessionId: crypto.randomUUID() });

    const { heard, onSessionEnded } = watching(unknown);

    await expect.poll(() => onSessionEnded.mock.calls).toHaveLength(1);
    expect(heard).toEqual([]);
  });

  it("hears nothing more once stopped", async () => {
    const { heard } = watching(token);
    await expect.poll(() => heard).toHaveLength(1);

    stop!();
    const [first] = await chainedParts({});
    await replaceDatabase(token, first!, { ifNoneMatch: true });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(heard).toHaveLength(1);
  });
});

/** A browser's WebSocket that a test opens, sends messages to and closes. */
class FakeSocket extends EventTarget {
  static made: FakeSocket[] = [];
  readonly url: string;
  readonly sent: string[] = [];

  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.made.push(this);
  }

  send(message: string) {
    this.sent.push(message);
  }

  close() {}

  open() {
    this.dispatchEvent(new Event("open"));
  }

  receive(data: string) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  drop(code = 1006) {
    this.dispatchEvent(new CloseEvent("close", { code }));
  }
}

describe("watchDatabase's socket", () => {
  const UPDATE = JSON.stringify({ latestPart: { index: 0, hash: "a".repeat(64) } });
  const latest = () => FakeSocket.made.at(-1)!;

  beforeEach(() => {
    FakeSocket.made = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("connects to the user's updates, and sends the token first", () => {
    watching("the-token");

    // The browser connects with ws: or wss:, as the page is served.
    expect(latest().url).toBe("/api/users/alice/database/updates");
    latest().open();
    expect(latest().sent).toEqual([JSON.stringify({ token: "the-token" })]);
  });

  it("pings while it's open, and stops once it's closed", () => {
    watching("the-token");
    latest().open();

    vi.advanceTimersByTime(PING_INTERVAL);
    expect(latest().sent.slice(1)).toEqual(["ping"]);
    latest().drop(4401);
    vi.advanceTimersByTime(PING_INTERVAL);

    expect(latest().sent.slice(1)).toEqual(["ping"]);
  });

  it("connects again after a drop, waiting longer each time in a row", () => {
    watching("the-token");

    for (const [tries, delay] of RETRY_DELAYS.slice(0, 3).entries()) {
      latest().drop();
      vi.advanceTimersByTime(delay - 1);
      expect(FakeSocket.made).toHaveLength(tries + 1);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.made).toHaveLength(tries + 2);
    }
  });

  it("waits the shortest time again once a connection has been told the last part", () => {
    watching("the-token");
    latest().drop();
    vi.advanceTimersByTime(RETRY_DELAYS[0]!);
    latest().drop();
    vi.advanceTimersByTime(RETRY_DELAYS[1]!);

    latest().receive(UPDATE);
    latest().drop();
    vi.advanceTimersByTime(RETRY_DELAYS[0]!);

    expect(FakeSocket.made).toHaveLength(4);
  });

  it("doesn't connect again once the session has ended", () => {
    const { onSessionEnded } = watching("the-token");

    latest().drop(4401);
    vi.advanceTimersByTime(60_000);

    expect(onSessionEnded).toHaveBeenCalledOnce();
    expect(FakeSocket.made).toHaveLength(1);
  });

  it("passes on updates, and nothing else it's sent", () => {
    const { heard } = watching("the-token");
    latest().open();

    latest().receive("pong");
    latest().receive("{");
    latest().receive(JSON.stringify({ latestPart: { index: 0, hash: "not a hash" } }));
    latest().receive(JSON.stringify({ latestPart: { index: -1, hash: "a".repeat(64) } }));
    // As the server used to say.
    latest().receive(JSON.stringify({ sha256: "a".repeat(64) }));
    latest().receive(UPDATE);
    latest().receive(JSON.stringify({ latestPart: null }));

    expect(heard).toEqual([{ index: 0, hash: "a".repeat(64) }, null]);
  });

  it("doesn't connect again once stopped", () => {
    watching("the-token");

    stop!();
    latest().drop();
    vi.advanceTimersByTime(60_000);

    expect(FakeSocket.made).toHaveLength(1);
  });
});
