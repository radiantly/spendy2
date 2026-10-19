import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { z } from "zod";
import { tokenSchema, usernameSchema } from "../schemas.ts";
import { requireAuth } from "../middleware/requireAuth.ts";

const auth = new Hono<{ Bindings: Env }>();

const LoginStartBody = z.strictObject({
  username: usernameSchema,
  startLoginRequest: z.string().max(4096),
});

const LoginFinishBody = z.strictObject({
  username: usernameSchema,
  finishLoginRequest: z.string().max(4096),
});

auth.post("/login/start", sValidator("json", LoginStartBody), async (c) => {
  const body = c.req.valid("json");
  const userStore = c.env.USER.getByName(body.username);

  const result = await userStore.startLoginRatelimited(body.startLoginRequest);
  if (!result.success)
    return c.json({ error: result.code }, result.code === "RATE_LIMITED" ? 429 : 400);

  return c.json({ loginResponse: result.loginResponse });
});

auth.post("/login/finish", sValidator("json", LoginFinishBody), async (c) => {
  const body = c.req.valid("json");
  const userStore = c.env.USER.getByName(body.username);

  const result = await userStore.finishLogin(body.finishLoginRequest);
  if (!result.success) return c.json({ error: result.code }, 401);

  return c.json({
    token: tokenSchema.encode({
      username: body.username,
      sessionId: result.sessionId,
    }),
  });
});

auth.post("/logout", requireAuth, async (c) => {
  const userStore = c.env.USER.getByName(c.var.username);
  const result = await userStore.logout(c.var.sessionId);
  if (!result.success) return c.json({ error: result.code }, 401);

  return c.body(null, 204);
});

export default auth;
