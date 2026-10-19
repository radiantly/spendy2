import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { tokenSchema, usernameSchema } from "../schemas.ts";
import { createAuthenticatedRoute } from "../middleware/requireAuth.ts";
import { createApiRoute, fixedResponse } from "../openapi.ts";

const auth = new OpenAPIHono<{ Bindings: Env }>();

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
  tags: ["Auth"],
  summary: "Start logging in",
  description:
    "Starts an OPAQUE login. After a failed or unfinished login, the next start is rejected " +
    "for a random delay that grows with each attempt; the delay isn't revealed.",
  request: {
    body: { required: true, content: { "application/json": { schema: LoginStartBody } } },
  },
  errors: ["INVALID_REQUEST", "RATE_LIMITED"],
  responses: {
    200: {
      description: "The server's OPAQUE login response",
      content: { "application/json": { schema: z.object({ loginResponse: z.string() }) } },
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
  tags: ["Auth"],
  summary: "Finish logging in",
  description: "Finishes an OPAQUE login and starts a session.",
  request: {
    body: { required: true, content: { "application/json": { schema: LoginFinishBody } } },
  },
  errors: ["INVALID_LOGIN", "INVALID_LOGIN_OR_TIMED_OUT"],
  responses: {
    200: {
      description: "A token for the new session, sent as a bearer token",
      content: { "application/json": { schema: z.object({ token: z.base64() }) } },
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
  tags: ["Auth"],
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
