import * as opaque from "@serenity-kit/opaque";
import { z } from "zod";

export type RegisterResult =
  | { success: true }
  | { success: false; code: "USER_ALREADY_EXISTS" | "REGISTRATION_FAILED" };

export type LoginResult =
  | { success: true; token: string; exportKey: string }
  | { success: false; code: LoginErrorCode };

/**
 * INVALID_LOGIN covers both a wrong password and an unknown username;
 * OPAQUE makes the two indistinguishable.
 */
export type LoginErrorCode = "INVALID_LOGIN" | "RATE_LIMITED" | "LOGIN_FAILED";

const RegistrationStartResponse = z.object({ registrationResponse: z.string() });
const LoginStartResponse = z.object({ loginResponse: z.string() });
const LoginFinishResponse = z.object({ token: z.string() });

function postAuth(path: string, body: object) {
  return fetch(`/api/auth/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Registers a user with the OPAQUE protocol. The password never leaves
 * the client; only the registration request and record are sent.
 *
 * Network failures throw.
 */
export async function registerUser(username: string, password: string): Promise<RegisterResult> {
  await opaque.ready;

  const { clientRegistrationState, registrationRequest } = opaque.client.startRegistration({
    password,
  });

  const startRes = await postAuth("register/start", { username, registrationRequest });
  if (!startRes.ok) {
    return { success: false, code: "REGISTRATION_FAILED" };
  }
  const { registrationResponse } = RegistrationStartResponse.parse(await startRes.json());

  const { registrationRecord } = opaque.client.finishRegistration({
    clientRegistrationState,
    registrationResponse,
    password,
  });

  const finishRes = await postAuth("register/finish", { username, registrationRecord });
  if (finishRes.status === 409) {
    return { success: false, code: "USER_ALREADY_EXISTS" };
  }
  if (!finishRes.ok) {
    return { success: false, code: "REGISTRATION_FAILED" };
  }

  return { success: true };
}

/**
 * Logs in with the OPAQUE protocol. The password never leaves the client.
 *
 * Network failures throw.
 */
export async function loginUser(username: string, password: string): Promise<LoginResult> {
  await opaque.ready;

  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({ password });

  const startRes = await postAuth("login/start", { username, startLoginRequest });
  if (startRes.status === 429) {
    return { success: false, code: "RATE_LIMITED" };
  }
  if (!startRes.ok) {
    return { success: false, code: "LOGIN_FAILED" };
  }
  const { loginResponse } = LoginStartResponse.parse(await startRes.json());

  // Returns undefined when the password is wrong or the user doesn't exist.
  const loginResult = opaque.client.finishLogin({ clientLoginState, loginResponse, password });
  if (!loginResult) {
    return { success: false, code: "INVALID_LOGIN" };
  }

  const finishRes = await postAuth("login/finish", {
    username,
    finishLoginRequest: loginResult.finishLoginRequest,
  });
  if (!finishRes.ok) {
    return { success: false, code: "LOGIN_FAILED" };
  }
  const { token } = LoginFinishResponse.parse(await finishRes.json());

  return { success: true, token, exportKey: loginResult.exportKey };
}
