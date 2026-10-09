import { exports } from "cloudflare:workers";
import * as opaque from "@serenity-kit/opaque";
import { expect, vi } from "vitest";

export const PASSWORD = "correct horse battery staple";

/**
 * Routes the global `fetch` to the worker, so frontend API clients (which
 * call relative URLs like `/api/users`) can be tested against the real
 * server. Undo with `vi.unstubAllGlobals()`.
 */
export function forwardFetchToWorker() {
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    exports.default.fetch(new URL(String(input), "http://localhost"), init),
  );
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

export async function startLogin(username: string, password = PASSWORD) {
  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({
    password,
  });
  const response = await post("/auth/login", { username, startLoginRequest });
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

  return post("/auth/login", {
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
