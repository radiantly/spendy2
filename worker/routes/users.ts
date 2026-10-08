import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import * as opaque from "@serenity-kit/opaque";
import { z } from "zod";
import { usernameSchema } from "../schemas.ts";
import { UserStoreError } from "../durable-objects/UserStore.ts";

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
  try {
    await userStore.registerNewUser(registrationRecord);
  } catch (error) {
    if (
      error instanceof UserStoreError &&
      error.message === "USER_ALREADY_EXISTS"
    )
      return c.json({ error: error.message }, 409);

    console.error("Unknown server error during user creation", error);
    return c.json({ error: "Unknown server error" }, 500);
  }

  return c.json({ success: `User ${username} was successfully created` }, 201);
});

export default users;
