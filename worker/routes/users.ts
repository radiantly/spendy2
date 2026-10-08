import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as opaque from "@serenity-kit/opaque";
import { z } from "zod";
import { usernameSchema } from "../schemas.ts";

const users = new Hono<{ Bindings: Env }>();

const UserRegistrationStartBody = z.strictObject({
  username: usernameSchema,
  registrationRequest: z.string().max(4096),
});

const UserRegistrationFinishBody = z.strictObject({
  username: usernameSchema,
  registrationRecord: z.string().max(4096),
});

const UserRegistrationBody = z.union([
  UserRegistrationStartBody,
  UserRegistrationFinishBody,
]);

users.post("/", zValidator("json", UserRegistrationBody), async (c) => {
  const body = c.req.valid("json");

  // registration start
  if ("registrationRequest" in body) {
    const { username, registrationRequest } = body;

    await opaque.ready;

    try {
      const { registrationResponse } = opaque.server.createRegistrationResponse(
        {
          serverSetup: c.env.OPAQUE_SERVER_SETUP,
          userIdentifier: username,
          registrationRequest,
        },
      );
      return c.json({ registrationResponse });
    } catch {
      return c.json({ error: "Invalid registration request" }, 400);
    }
  }

  const { username, registrationRecord } = body;

  const userStore = c.env.USER.getByName(username);
  const result = await userStore.registerNewUser(registrationRecord);
  if (!result.success)
    return c.json(
      { error: result.code },
      result.code === "USER_ALREADY_EXISTS" ? 409 : 500,
    );

  return c.json({ success: `User ${username} was successfully created` }, 201);
});

export default users;
