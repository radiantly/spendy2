import * as opaque from "@serenity-kit/opaque";
import { z } from "zod";

export type RegisterResult =
  | { success: true }
  | { success: false; code: "USER_ALREADY_EXISTS" | "REGISTRATION_FAILED" };

const RegistrationStartResponse = z.object({
  registrationResponse: z.string(),
});

function postUsers(body: object) {
  return fetch("/api/users", {
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
export async function registerUser(
  username: string,
  password: string,
): Promise<RegisterResult> {
  await opaque.ready;

  const { clientRegistrationState, registrationRequest } =
    opaque.client.startRegistration({ password });

  const startRes = await postUsers({ username, registrationRequest });
  if (!startRes.ok) {
    return { success: false, code: "REGISTRATION_FAILED" };
  }
  const { registrationResponse } = RegistrationStartResponse.parse(
    await startRes.json(),
  );

  const { registrationRecord } = opaque.client.finishRegistration({
    clientRegistrationState,
    registrationResponse,
    password,
  });

  const finishRes = await postUsers({ username, registrationRecord });
  if (finishRes.status === 409) {
    return { success: false, code: "USER_ALREADY_EXISTS" };
  }
  if (!finishRes.ok) {
    return { success: false, code: "REGISTRATION_FAILED" };
  }

  return { success: true };
}
