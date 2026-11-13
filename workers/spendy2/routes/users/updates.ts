import { OpenAPIHono } from "@hono/zod-openapi";
import { z } from "zod";
import { createApiRoute, fixedResponse } from "../../openapi.ts";
import { usernameSchema } from "../../schemas.ts";
import { DATABASE_TAG } from "./database.ts";

const updates = new OpenAPIHono<{ Bindings: Env }>();

const watchDatabase = createApiRoute({
  // This API is too ugly. Auth is done via first message, username must be passed in the url ("me" does not work)
  hide: true,
  method: "get",
  path: "/{username}/database/updates",
  tags: [DATABASE_TAG],
  summary: "Watch for database changes",
  description: `Open a websocket to receive updates for when the database is changed.

The client must send the token in the following format as the first message: \`{"token": "<token>"}\`.

Once authenticated, the server will respond with \`{"latestPart": {"index": <index>, "hash": "<sha256 of part>"}}\` (or \`{"latestPart": null}\` if no database parts exist)  and then continue to send this message every time the database is updated.`,
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
