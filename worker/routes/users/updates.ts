import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { createApiRoute, fixedResponse } from "../../openapi.ts";
import { DATABASE_UPDATES_CLOSE, usernameSchema } from "../../schemas.ts";
import { DATABASE_TAG } from "./database.ts";

const updates = new OpenAPIHono<{ Bindings: Env }>();

const watchDatabase = createApiRoute({
  method: "get",
  path: "/{username}/database/updates",
  tags: [DATABASE_TAG],
  summary: "Watch the database",
  description:
    "Opens a WebSocket that's told each time the database changes. A WebSocket from a browser " +
    "can't send an `Authorization` header, so the first message has to authenticate instead: " +
    '`{"token": "<token>"}`, with the token from logging in as `username`, sent within a few ' +
    "seconds. Until then the socket is sent nothing.\n\n" +
    'Once it\'s authenticated, it\'s sent `{"sha256": "<sha256>"}` straight away, and again after ' +
    "every upload, with the database's ETag: the sha256 of its last part, or null without a " +
    "database. Sending `ping` gets `pong`.\n\n" +
    `The socket is closed with code ${DATABASE_UPDATES_CLOSE.UNAUTHORIZED} if the token isn't ` +
    "for an active session of `username`, or once that session has ended, and with code " +
    `${DATABASE_UPDATES_CLOSE.AUTH_TIMEOUT} if no token came in time.`,
  request: { params: z.object({ username: usernameSchema }) },
  errors: ["UPGRADE_REQUIRED"],
  responses: {
    101: { description: "The WebSocket is open" },
  },
});

updates.openapi(watchDatabase, (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket")
    return fixedResponse(c, "UPGRADE_REQUIRED");
  return c.env.USER.getByName(c.req.valid("param").username).fetch(c.req.raw);
});

export default updates;
