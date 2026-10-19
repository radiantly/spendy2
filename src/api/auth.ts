import * as opaque from "@serenity-kit/opaque";
import { z } from "zod";

export type LoginResult =
  | { success: true; token: string; exportKey: string }
  | { success: false; code: LoginErrorCode };

/**
 * INVALID_LOGIN covers both a wrong password and an unknown username;
 * OPAQUE makes the two indistinguishable.
 */
export type LoginErrorCode = "INVALID_LOGIN" | "RATE_LIMITED" | "LOGIN_FAILED";

const LoginStartResponse = z.object({ loginResponse: z.string() });
const LoginFinishResponse = z.object({ token: z.string() });

function postLogin(step: "start" | "finish", body: object) {
  return fetch(`/api/auth/login/${step}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Logs in with the OPAQUE protocol. The password never leaves the client.
 *
 * Network failures throw.
 */
export async function loginUser(username: string, password: string): Promise<LoginResult> {
  await opaque.ready;

  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({ password });

  const startRes = await postLogin("start", { username, startLoginRequest });
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

  const finishRes = await postLogin("finish", {
    username,
    finishLoginRequest: loginResult.finishLoginRequest,
  });
  if (!finishRes.ok) {
    return { success: false, code: "LOGIN_FAILED" };
  }
  const { token } = LoginFinishResponse.parse(await finishRes.json());

  return { success: true, token, exportKey: loginResult.exportKey };
}
