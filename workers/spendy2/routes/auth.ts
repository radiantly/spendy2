import { OpenAPIHono } from "@hono/zod-openapi";
import * as opaque from "@serenity-kit/opaque";
import { z } from "zod";
import { tokenSchema, usernameSchema } from "../schemas.ts";
import { createAuthenticatedRoute } from "../middleware/requireAuth.ts";
import { createApiRoute, fixedResponse } from "../openapi.ts";

const auth = new OpenAPIHono<{ Bindings: Env }>();

export const authTag = {
  name: "Auth",
  description: `Spendy2 uses [OPAQUE](https://opaque-auth.com/) auth to prevent sending your
password to the server. This requires two requests for both user registration and login, and each
of these operations have \`/start\` and \`/finish\` endpoints that must be called in quick
succession.`,
};

const RegisterStartBody = z.strictObject({
  username: usernameSchema,
  registrationRequest: z.string().max(4096),
});

const RegisterFinishBody = z.strictObject({
  username: usernameSchema,
  registrationRecord: z.string().max(4096),
});

const registerStart = createApiRoute({
  method: "post",
  path: "/register/start",
  tags: [authTag.name],
  summary: "Register (start)",
  description:
    "Create a new user with the supplied username. The corresponding `/finish` request must be called for the user to be successfully created.",
  request: {
    body: { required: true, content: { "application/json": { schema: RegisterStartBody } } },
  },
  errors: ["INVALID_REGISTRATION_REQUEST"],
  responses: {
    200: {
      description: "The server's OPAQUE registration response",
      content: { "application/json": { schema: z.object({ registrationResponse: z.string() }) } },
    },
  },
});

auth.openapi(registerStart, async (c) => {
  const { username, registrationRequest } = c.req.valid("json");

  await opaque.ready;

  try {
    const { registrationResponse } = opaque.server.createRegistrationResponse({
      serverSetup: c.env.OPAQUE_SERVER_SETUP,
      userIdentifier: username,
      registrationRequest,
    });
    return c.json({ registrationResponse }, 200);
  } catch {
    return fixedResponse(c, "INVALID_REGISTRATION_REQUEST");
  }
});

const registerFinish = createApiRoute({
  method: "post",
  path: "/register/finish",
  tags: [authTag.name],
  summary: "Register (finish)",
  description: "Complete user creation.",
  request: {
    body: { required: true, content: { "application/json": { schema: RegisterFinishBody } } },
  },
  errors: ["USER_ALREADY_EXISTS"],
  responses: {
    204: { description: "The user was created" },
  },
});

auth.openapi(registerFinish, async (c) => {
  const { username, registrationRecord } = c.req.valid("json");

  const userStore = c.env.USER.getByName(username);
  const result = await userStore.registerNewUser(registrationRecord);
  if (!result.success) return fixedResponse(c, result.code);

  return fixedResponse(c, "NO_CONTENT");
});

const LoginStartBody = z.strictObject({
  username: usernameSchema,
  startLoginRequest: z.string().max(4096),
});

const LoginFinishBody = z.strictObject({
  username: usernameSchema,
  finishLoginRequest: z.string().max(4096),
});

const loginStart = createApiRoute({
  method: "post",
  path: "/login/start",
  tags: [authTag.name],
  summary: "Login (start)",
  description:
    "Log in with a given username. `/finish` must be called to complete the login process.",
  request: {
    body: { required: true, content: { "application/json": { schema: LoginStartBody } } },
  },
  errors: ["INVALID_REQUEST", "RATE_LIMITED"],
  responses: {
    200: {
      description: "Login started. Finish logging in using the API below.",
      content: {
        "application/json": {
          schema: z.object({
            loginResponse: z.string().meta({
              description:
                "The server's login response. Use with an OPAQUE client library to complete login.",
            }),
          }),
        },
      },
    },
  },
});

auth.openapi(loginStart, async (c) => {
  const body = c.req.valid("json");
  const userStore = c.env.USER.getByName(body.username);

  const result = await userStore.startLoginRatelimited(body.startLoginRequest);
  if (!result.success) return fixedResponse(c, result.code);

  return c.json({ loginResponse: result.loginResponse }, 200);
});

const loginFinish = createApiRoute({
  method: "post",
  path: "/login/finish",
  tags: [authTag.name],
  summary: "Login (finish)",
  description: "Completes the log in and returns a bearer token.",
  request: {
    body: { required: true, content: { "application/json": { schema: LoginFinishBody } } },
  },
  errors: ["INVALID_LOGIN", "INVALID_LOGIN_OR_TIMED_OUT"],
  responses: {
    200: {
      description: "Session has been successfully created.",
      content: {
        "application/json": {
          schema: z.object({
            token: z.base64().meta({
              description:
                "This token can now be used in the `Authorization` header for all requests requiring authentication.",
            }),
          }),
        },
      },
    },
  },
});

auth.openapi(loginFinish, async (c) => {
  const body = c.req.valid("json");
  const userStore = c.env.USER.getByName(body.username);

  const result = await userStore.finishLogin(body.finishLoginRequest);
  if (!result.success) return fixedResponse(c, result.code);

  return c.json(
    {
      token: tokenSchema.encode({
        username: body.username,
        sessionId: result.sessionId,
      }),
    },
    200,
  );
});

const logout = createAuthenticatedRoute({
  method: "post",
  path: "/logout",
  tags: [authTag.name],
  summary: "Log out",
  description: "Ends the current session.",
  responses: {
    204: { description: "Logged out" },
  },
});

auth.openapi(logout, async (c) => {
  const userStore = c.env.USER.getByName(c.var.username);
  const result = await userStore.logout(c.var.sessionId);
  if (!result.success) return fixedResponse(c, result.code);

  return fixedResponse(c, "NO_CONTENT");
});

export default auth;
