import * as opaque from "@serenity-kit/opaque";
import { confirm, group, intro, isCancel, outro, password, text } from "@clack/prompts";
import path from "path";
import { unstable_readConfig } from "wrangler";
import { usernameSchema } from "../worker/schemas.ts";
import { fail, onCancel, readEnv, required, url, writeEnv } from "./lib.ts";
import { z } from "zod";

const scriptsEnvPath = path.join(import.meta.dirname, ".env");
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

async function post(endpoint: string, route: string, body: unknown) {
  const target = new URL(`/api${route}`, endpoint);
  try {
    return await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    fail(`Could not reach ${target}`);
  }
}

async function describe(response: Response) {
  return `${response.status} ${await response.text()}`;
}

/**
 * Returns undefined when the login is rejected. OPAQUE does not reveal whether
 * the user doesn't exist or the password is wrong.
 */
async function login(
  endpoint: string,
  username: string,
  password: string,
): Promise<Session | undefined> {
  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({
    password,
  });
  const startResponse = await post(endpoint, "/auth/login", {
    username,
    startLoginRequest,
  });
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

  const finishResponse = await post(endpoint, "/auth/login", {
    username,
    finishLoginRequest: result.finishLoginRequest,
  });
  if (!finishResponse.ok) fail(`Login failed: ${await describe(finishResponse)}`);
  const { token } = (await finishResponse.json()) as { token: string };

  return { token, exportKey: result.exportKey };
}

async function register(endpoint: string, username: string, password: string) {
  const { clientRegistrationState, registrationRequest } = opaque.client.startRegistration({
    password,
  });
  const startResponse = await post(endpoint, "/users", {
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
  const finishResponse = await post(endpoint, "/users", {
    username,
    registrationRecord,
  });
  if (finishResponse.status === 409) fail(`${username} already exists, the password is wrong`);
  if (!finishResponse.ok) fail(`Registration failed: ${await describe(finishResponse)}`);
}

/** Returns undefined when the login failed and the user declined to register. */
async function loginOrRegister(endpoint: string, username: string, password: string) {
  const session = await login(endpoint, username, password);
  if (session !== undefined) return session;

  const shouldRegister = await confirm({
    message: `Login failed, the password is wrong or ${username} doesn't exist. Register ${username}?`,
    initialValue: false,
  });
  if (isCancel(shouldRegister)) onCancel();
  if (!shouldRegister) return;

  await register(endpoint, username, password);
  return (await login(endpoint, username, password)) ?? fail("Login failed after registering");
}

intro(`Init session`);

await opaque.ready;

const env = readEnv(scriptsEnvPath);

const input = await group(
  {
    endpoint: () =>
      text({
        message: "Spendy2 endpoint?",
        placeholder: "http://localhost:5173",
        initialValue: env.SPENDY2_ENDPOINT ?? deployedEndpoint(),
        validate: url,
      }),
    username: () =>
      text({
        message: "Username?",
        initialValue: env.SPENDY2_USERNAME,
        validate: usernameSchema,
      }),
    password: () => password({ message: "Password?", validate: required }),
  },
  { onCancel },
);

const session = await loginOrRegister(input.endpoint, input.username, input.password);

if (session === undefined) {
  writeEnv(scriptsEnvPath, { SPENDY2_ENDPOINT: input.endpoint });
  outro(`Saved the endpoint without a session`);
} else {
  writeEnv(scriptsEnvPath, {
    SPENDY2_ENDPOINT: input.endpoint,
    SPENDY2_USERNAME: input.username,
    SPENDY2_TOKEN: session.token,
    SPENDY2_EXPORT_KEY: session.exportKey,
  });
  outro(`Logged in as ${input.username}`);
}
