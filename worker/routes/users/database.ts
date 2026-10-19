import { OpenAPIHono } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { createMiddleware } from "hono/factory";
import { endTime, startTime, timing } from "hono/timing";
import { z } from "zod";
import { createAuthenticatedRoute } from "../../middleware/requireAuth.ts";
import {
  databaseBlobSchema,
  databaseEtagSchema,
  databaseGetPreconditionSchema,
  databasePutHeadersSchema,
} from "../../schemas.ts";
import { fixedResponse } from "../../openapi.ts";

const database = new OpenAPIHono<{ Bindings: Env }>();

/** bodyLimit at the configured maximum, which only the request's env has. */
const databaseBodyLimit = createMiddleware<{ Bindings: Env }>((c, next) =>
  bodyLimit({ maxSize: c.env.MAX_DATABASE_UPLOAD_BYTES })(c, next),
);

/** Documents a database blob; the user store checks uploads itself. */
const databaseBlobBody = databaseBlobSchema.meta({
  type: "string",
  format: "binary",
  description: "SPENDY, a version byte, then data only clients read",
});

const etagHeaders = z.object({
  ETag: databaseEtagSchema.meta({ description: "The stored database's sha256" }),
});

const uploadDatabase = createAuthenticatedRoute({
  method: "put",
  path: "/",
  tags: ["Database"],
  summary: "Upload the database",
  description:
    "Replaces the stored database, if it is still the one the precondition names. " +
    "The upload must say how long it is.",
  middleware: [timing(), databaseBodyLimit],
  request: {
    headers: databasePutHeadersSchema,
    body: { required: true, content: { "application/octet-stream": { schema: databaseBlobBody } } },
  },
  errors: ["MISSING_SPENDY_MAGIC", "INVALID_VERSION_BYTE", "PRECONDITION_FAILED"],
  responses: {
    204: { description: "The upload is now the stored database", headers: etagHeaders },
    413: {
      description: "The upload is larger than the maximum",
      content: { "text/plain": { schema: z.literal("Payload Too Large") } },
    },
  },
});

database.openapi(uploadDatabase, async (c) => {
  const body = c.req.raw.body;
  if (body === null) return fixedResponse(c, "MISSING_SPENDY_MAGIC");

  const userStore = c.env.USER.getByName(c.var.username);

  // the body is streamed to the user store as it arrives
  startTime(c, "store", "Receiving and storing it");
  const result = await userStore.uploadDatabase(
    c.var.sessionId,
    body,
    c.req.valid("header")["if-match"] ?? null,
  );
  endTime(c, "store");

  if (!result.success) return fixedResponse(c, result.code);

  return fixedResponse(c, "NO_CONTENT", { ETag: databaseEtagSchema.encode(result.sha256) });
});

const downloadDatabase = createAuthenticatedRoute({
  method: "get",
  path: "/",
  tags: ["Database"],
  summary: "Download the database",
  request: { headers: databaseGetPreconditionSchema },
  errors: ["NOT_FOUND"],
  responses: {
    200: {
      description: "The stored database",
      headers: etagHeaders,
      content: { "application/octet-stream": { schema: databaseBlobBody } },
    },
    304: { description: "The stored database is the If-None-Match one", headers: etagHeaders },
  },
});

database.openapi(downloadDatabase, async (c) => {
  const userStore = c.env.USER.getByName(c.var.username);
  const result = await userStore.downloadDatabase(
    c.var.sessionId,
    c.req.valid("header")["if-none-match"] ?? null,
  );
  if (!result.success) return fixedResponse(c, result.code);

  if (!result.modified)
    return fixedResponse(c, "NOT_MODIFIED", { ETag: databaseEtagSchema.encode(result.sha256) });

  return c.body(result.body, 200, {
    "Content-Type": "application/octet-stream",
    ETag: databaseEtagSchema.encode(result.sha256),
  });
});

export default database;
