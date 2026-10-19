import { OpenAPIHono } from "@hono/zod-openapi";
import * as opaque from "@serenity-kit/opaque";
import { z } from "zod";
import { usernameSchema } from "../../schemas.ts";
import { createApiRoute, fixedResponse } from "../../openapi.ts";
import database from "./database.ts";

const users = new OpenAPIHono<{ Bindings: Env }>();
users.route("/me/database", database);

const UserRegistrationStartBody = z.strictObject({
  username: usernameSchema,
  registrationRequest: z.string().max(4096),
});

const UserRegistrationFinishBody = z.strictObject({
  username: usernameSchema,
  registrationRecord: z.string().max(4096),
});

const UserRegistrationBody = z.union([UserRegistrationStartBody, UserRegistrationFinishBody]);

const registerUser = createApiRoute({
  method: "post",
  path: "/",
  tags: ["Users"],
  summary: "Register a user",
  description:
    "Registers a user with OPAQUE in two requests: a registrationRequest returns the " +
    "registrationResponse, then the registrationRecord creates the user.",
  request: {
    body: { required: true, content: { "application/json": { schema: UserRegistrationBody } } },
  },
  errors: ["INVALID_REGISTRATION_REQUEST", "USER_ALREADY_EXISTS"],
  responses: {
    200: {
      description: "The server's OPAQUE registration response",
      content: { "application/json": { schema: z.object({ registrationResponse: z.string() }) } },
    },
    201: {
      description: "The user was created",
      content: { "application/json": { schema: z.object({ success: z.string() }) } },
    },
  },
});

users.openapi(registerUser, async (c) => {
  const body = c.req.valid("json");

  // registration start
  if ("registrationRequest" in body) {
    const { username, registrationRequest } = body;

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
  }

  const { username, registrationRecord } = body;

  const userStore = c.env.USER.getByName(username);
  const result = await userStore.registerNewUser(registrationRecord);
  if (!result.success) return fixedResponse(c, result.code);

  return c.json({ success: `User ${username} was successfully created` }, 201);
});

export default users;
