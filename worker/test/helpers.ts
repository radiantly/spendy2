import { exports } from "cloudflare:workers";
import * as opaque from "@serenity-kit/opaque";
import { expect, vi } from "vitest";
import {
  AAD_OFFSET,
  LENGTH_OFFSET,
  MIN_PART_LENGTH,
  NO_PREVIOUS_PART,
  PART_MAGIC,
  PART_VERSION,
  USER_VERSION_OFFSET,
  VERSION_OFFSET,
  sha256Hex,
} from "../databaseParts.ts";

export const PASSWORD = "correct horse battery staple";

export interface PartOptions {
  userVersion?: number;
  /** The whole part's length. */
  size?: number;
  /** Changes the bytes after the AAD, so otherwise equal parts differ. */
  seed?: number;
}

/**
 * A part after the one whose sha256 is `previousHash`, in the format the
 * server checks. Past the AAD, it holds bytes that stand in for the nonce
 * and ciphertext, which only clients read. They differ all along the part,
 * so chunks stored out of order would show.
 */
export function databasePart(
  previousHash: string,
  { userVersion = 1, size = MIN_PART_LENGTH, seed = 0 }: PartOptions = {},
) {
  const bytes = Uint8Array.from({ length: size }, (_, i) => (i + seed) % 251);
  bytes.set(PART_MAGIC);
  bytes[VERSION_OFFSET] = PART_VERSION;
  const view = new DataView(bytes.buffer);
  view.setUint32(LENGTH_OFFSET, size, true);
  bytes.set(fromHex(previousHash), AAD_OFFSET);
  view.setUint32(USER_VERSION_OFFSET, userVersion, true);
  return bytes;
}

/**
 * Parts that chain from part 0, one for each of `options`. Each is seeded by
 * its position unless its options say otherwise.
 */
export async function chainedParts(...options: PartOptions[]) {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let previousHash = NO_PREVIOUS_PART;
  for (const [i, partOptions] of options.entries()) {
    const part = databasePart(previousHash, { seed: i, ...partOptions });
    parts.push(part);
    previousHash = await sha256Hex(part);
  }
  return parts;
}

/** `parts` one after the other. */
export function concatBytes(parts: Uint8Array[]) {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

function fromHex(hex: string) {
  return Uint8Array.from(hex.match(/../g) ?? [], (byte) => parseInt(byte, 16));
}

/**
 * Routes the global `fetch` to the worker, so frontend API clients (which
 * call relative URLs like `/api/auth/register/start`) can be tested against the real
 * server. Requests to other origins go to the previous `fetch`: the worker
 * and its durable objects share this global, so their own requests must not
 * be looped back. Undo with `vi.unstubAllGlobals()`.
 */
export function forwardFetchToWorker() {
  const previousFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input, WORKER_ORIGIN);
    if (url.origin !== WORKER_ORIGIN) return previousFetch(input, init);
    return exports.default.fetch(input instanceof Request ? new Request(input, init) : url, init);
  });
}

/** What relative URLs resolve against, as on the page the app is served from. */
const WORKER_ORIGIN = "http://localhost";

/**
 * A browser's WebSocket, as far as the frontend uses one, connected to the
 * worker: it opens, is sent messages and closes as the browser's would.
 */
class WorkerWebSocket extends EventTarget {
  #ws: WebSocket | undefined;
  #closed = false;

  constructor(url: string) {
    super();
    // Relative to the page, as a browser takes it.
    const target = new URL(url, WORKER_ORIGIN);
    void exports.default.fetch(target, { headers: { Upgrade: "websocket" } }).then((response) => {
      const ws = response.webSocket;
      if (!ws) {
        this.#close(1006, "");
        return;
      }
      ws.accept();
      this.#ws = ws;
      ws.addEventListener("message", ({ data }) =>
        this.dispatchEvent(new MessageEvent("message", { data })),
      );
      ws.addEventListener("close", ({ code, reason }) => this.#close(code, reason));
      if (this.#closed) ws.close();
      else this.dispatchEvent(new Event("open"));
    });
  }

  #close(code: number, reason: string) {
    if (this.#closed) return;
    this.#closed = true;
    this.dispatchEvent(new CloseEvent("close", { code, reason }));
  }

  send(message: string) {
    this.#ws!.send(message);
  }

  close() {
    this.#ws?.close();
    this.#close(1000, "");
  }
}

/**
 * Routes the global `WebSocket` to the worker, as `forwardFetchToWorker`
 * does `fetch`. Undo with `vi.unstubAllGlobals()`.
 */
export function forwardWebSocketsToWorker() {
  vi.stubGlobal("WebSocket", WorkerWebSocket);
}

export function post(path: string, body: unknown) {
  return exports.default.fetch(`http://localhost/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function registerUser(username: string, password = PASSWORD) {
  const { clientRegistrationState, registrationRequest } = opaque.client.startRegistration({
    password,
  });
  const startResponse = await post("/auth/register/start", { username, registrationRequest });
  const { registrationResponse } = await startResponse.json<{
    registrationResponse: string;
  }>();
  const { registrationRecord } = opaque.client.finishRegistration({
    clientRegistrationState,
    registrationResponse,
    password,
  });
  const finishResponse = await post("/auth/register/finish", {
    username,
    registrationRecord,
  });
  expect(finishResponse.status).toBe(204);
}

export async function startLogin(username: string, password = PASSWORD) {
  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({
    password,
  });
  const response = await post("/auth/login/start", { username, startLoginRequest });
  return { response, clientLoginState };
}

/** Runs a full login and returns the finish response. */
export async function login(username: string, password = PASSWORD) {
  const { response, clientLoginState } = await startLogin(username, password);
  expect(response.status).toBe(200);
  const { loginResponse } = await response.json<{ loginResponse: string }>();

  const result = opaque.client.finishLogin({
    clientLoginState,
    loginResponse,
    password,
  });
  expect(result).toBeDefined();

  return post("/auth/login/finish", {
    username,
    finishLoginRequest: result!.finishLoginRequest,
  });
}

/** Runs a full login and returns the token. */
export async function loginToken(username: string) {
  const response = await login(username);
  expect(response.status).toBe(200);
  const { token } = await response.json<{ token: string }>();
  return token;
}
