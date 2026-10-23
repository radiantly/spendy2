import { exports } from "cloudflare:workers";
import * as opaque from "@serenity-kit/opaque";
import { expect, vi } from "vitest";

export const PASSWORD = "correct horse battery staple";

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
