/**
 * Logs in, registering the user first if asked to, and keeps the session in
 * the user's `User Data (username)` directory for the other scripts.
 *
 *   npm run init-session -- --endpoint <url> --username <name> --password <password> [--register]
 */
import * as opaque from "@serenity-kit/opaque";
import { confirm, intro, outro, password, text } from "@clack/prompts";
import path from "path";
import { setTimeout } from "timers/promises";
import { unstable_readConfig } from "wrangler";
import { deriveKekBytes } from "../src/lib/kek.ts";
import { usernameSchema } from "../worker/schemas.ts";
import { send } from "./api.ts";
import { booleanFlag, parseFlags, textFlag } from "./flags.ts";
import { fail, required, url } from "./lib.ts";
import { saveSession } from "./userData.ts";
import { z } from "zod";

const wranglerConfigPath = path.join(import.meta.dirname, "..", "wrangler.jsonc");

/**
 * The URL of the deployed worker. Only a custom domain route maps to a URL,
 * other route patterns can contain wildcards and paths.
 */
function deployedEndpoint() {
  const { route } = unstable_readConfig({ config: wranglerConfigPath }, { hideWarnings: true });
  let result = z
    .strictObject({
      pattern: z.string(),
      custom_domain: z.literal(true),
    })
    .safeParse(route);
  if (result.success) return `https://${result.data.pattern}`;
}

type Session = { token: string; exportKey: string };

function post(endpoint: string, route: string, body: unknown) {
  return send(new URL(`/api${route}`, endpoint), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function describe(response: Response) {
  return `${response.status} ${await response.text()}`;
}

/** How long a login waits for the server to take another attempt, when asked to. */
const BACKOFF_WAIT_MS = 5000;
const BACKOFF_POLL_MS = 250;

/**
 * Returns undefined when the login is rejected. OPAQUE does not reveal whether
 * the user doesn't exist or the password is wrong.
 *
 * After an attempt that didn't log in, the server refuses the user's next
 * one for a moment. `waitOutBackoff` waits for it to pass, for when the
 * attempt before was this script's own.
 */
async function login(
  endpoint: string,
  username: string,
  password: string,
  { waitOutBackoff = false } = {},
): Promise<Session | undefined> {
  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({
    password,
  });
  const start = () => post(endpoint, "/auth/login/start", { username, startLoginRequest });
  let startResponse = await start();
  for (
    let waited = 0;
    startResponse.status === 429 && waitOutBackoff && waited < BACKOFF_WAIT_MS;
    waited += BACKOFF_POLL_MS
  ) {
    await setTimeout(BACKOFF_POLL_MS);
    startResponse = await start();
  }
  if (startResponse.status === 429)
    fail("Too many login attempts, wait a few seconds and run this again");
  if (!startResponse.ok) fail(`Login failed: ${await describe(startResponse)}`);
  const { loginResponse } = (await startResponse.json()) as {
    loginResponse: string;
  };

  const result = opaque.client.finishLogin({
    clientLoginState,
    loginResponse,
    password,
  });
  if (result === undefined) return;

  const finishResponse = await post(endpoint, "/auth/login/finish", {
    username,
    finishLoginRequest: result.finishLoginRequest,
  });
  if (!finishResponse.ok) fail(`Login failed: ${await describe(finishResponse)}`);
  const { token } = (await finishResponse.json()) as { token: string };

  return { token, exportKey: result.exportKey };
}

async function registerUser(endpoint: string, username: string, password: string) {
  const { clientRegistrationState, registrationRequest } = opaque.client.startRegistration({
    password,
  });
  const startResponse = await post(endpoint, "/auth/register/start", {
    username,
    registrationRequest,
  });
  if (!startResponse.ok) fail(`Registration failed: ${await describe(startResponse)}`);
  const { registrationResponse } = (await startResponse.json()) as {
    registrationResponse: string;
  };

  const { registrationRecord } = opaque.client.finishRegistration({
    clientRegistrationState,
    registrationResponse,
    password,
  });
  const finishResponse = await post(endpoint, "/auth/register/finish", {
    username,
    registrationRecord,
  });
  if (finishResponse.status === 409) fail(`${username} already exists, the password is wrong`);
  if (!finishResponse.ok) fail(`Registration failed: ${await describe(finishResponse)}`);
}

function username(value: string | undefined) {
  if (!usernameSchema.safeParse(value).success) return "3 to 32 lowercase letters and digits";
}

const flags = parseFlags({
  endpoint: { type: "string" },
  username: { type: "string" },
  password: { type: "string" },
  /** Registers the user if the login fails; `--no-register` never does. */
  register: { type: "boolean" },
});

intro(`Init session`);

await opaque.ready;

const input = {
  endpoint: await textFlag("endpoint", flags.endpoint, url, () =>
    text({
      message: "Spendy2 endpoint?",
      placeholder: "http://localhost:5173",
      initialValue: deployedEndpoint(),
      validate: url,
    }),
  ),
  username: await textFlag("username", flags.username, username, () =>
    text({ message: "Username?", validate: username }),
  ),
  password: await textFlag("password", flags.password, required, () =>
    password({ message: "Password?", validate: required }),
  ),
};

let session = await login(input.endpoint, input.username, input.password);
if (session === undefined) {
  const rejected = `Login failed, the password is wrong or ${input.username} doesn't exist`;
  const register = await booleanFlag(
    flags.register,
    () => confirm({ message: `${rejected}. Register ${input.username}?`, initialValue: false }),
    `${rejected}. Pass --register to register ${input.username}`,
  );
  if (!register) fail(rejected);

  await registerUser(input.endpoint, input.username, input.password);
  // The login above, of a user there wasn't, counts as an attempt that failed.
  session =
    (await login(input.endpoint, input.username, input.password, { waitOutBackoff: true })) ??
    fail("Login failed after registering");
}

saveSession(flags.root, {
  endpoint: input.endpoint,
  username: input.username,
  token: session.token,
  kek: await deriveKekBytes(session.exportKey),
});
outro(`Logged in as ${input.username}, you can now pull the database.`);
