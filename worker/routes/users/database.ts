import { OpenAPIHono } from "@hono/zod-openapi";
import { endTime, startTime, timing } from "hono/timing";
import { z } from "zod";
import { createAuthenticatedRoute } from "../../middleware/requireAuth.ts";
import {
  databaseBlobSchema,
  databaseEtagSchema,
} from "../../schemas.ts";
import { fixedResponse } from "../../openapi.ts";

const database = new OpenAPIHono<{ Bindings: Env }>();

export const DATABASE_TAG = "Database";

/** The Database tag, which shows the database's tables by their CREATE TABLE statements. */
export function databaseTag(tables: string[]) {
  return {
    name: DATABASE_TAG,
    description:
      "All of the user data is stored in a single encrypted, compressed SQLite database " +
      "with the following table schema:\n\n" +
      `\`\`\`sql\n${tables.map((sql) => `${sql};`).join("\n\n")}\n\`\`\``,
  };
}

const databasePutHeadersSchema = z
  .object({
    "if-match": databaseEtagSchema
      .optional()
      .meta({ description: "If the user has an existing database, this header is required. Pass the ETag from the corresponding GET call for the value of this header." }),
    "if-none-match": z.literal("*").optional().meta({ description: "If the user does NOT have an existing database, this header is required. Pass `*` for the value of this header." }),
    "content-length": z.string().regex(/^\d+$/),
  })
  .refine(
    (headers) => (headers["if-match"] === undefined) !== (headers["if-none-match"] === undefined),
    { error: "Needs exactly one of If-Match and If-None-Match" },
  );

/** Documents a database blob; the user store checks uploads itself. */
const databaseBlobBody = databaseBlobSchema.meta({
  type: "string",
  format: "binary",
  description: "`SPENDY` + `01` + wrapped key (40 bytes) + nonce (12 bytes) + AES-GCM(gzip(sqlite file))",
});

const etagHeaders = z.object({
  ETag: databaseEtagSchema,
});

const uploadDatabase = createAuthenticatedRoute({
  method: "put",
  path: "/",
  tags: [DATABASE_TAG],
  summary: "Upload the database",
  description:
    "Upload a new version of the database.",
  middleware: [timing()],
  request: {
    headers: databasePutHeadersSchema,
    body: { required: true, content: { "application/octet-stream": { schema: databaseBlobBody } } },
  },
  errors: [
    "MISSING_SPENDY_MAGIC",
    "INVALID_VERSION_BYTE",
    "PRECONDITION_FAILED",
    "DATABASE_TOO_LARGE",
  ],
  responses: {
    204: { description: "The upload is now the stored database", headers: etagHeaders },
  },
});

database.openapi(uploadDatabase, async (c) => {
  const headers = c.req.valid("header");
  // checked before reading the body, which can't be longer than its Content-Length
  if (Number(headers["content-length"]) > c.env.MAX_DATABASE_UPLOAD_BYTES)
    return fixedResponse(c, "DATABASE_TOO_LARGE");

  const body = c.req.raw.body;
  if (body === null) return fixedResponse(c, "MISSING_SPENDY_MAGIC");

  const userStore = c.env.USER.getByName(c.var.username);

  // the body is streamed to the user store as it arrives
  startTime(c, "store", "Receiving and storing it");
  const result = await userStore.uploadDatabase(c.var.sessionId, body, headers["if-match"] ?? null);
  endTime(c, "store");

  if (!result.success) return fixedResponse(c, result.code);

  return fixedResponse(c, "NO_CONTENT", { ETag: databaseEtagSchema.encode(result.sha256) });
});

export const databaseGetPreconditionSchema = z.object({
  "if-none-match": databaseEtagSchema
    .optional(),
});

const downloadDatabase = createAuthenticatedRoute({
  method: "get",
  path: "/",
  tags: [DATABASE_TAG],
  summary: "Download the database",
  description:
    "Downloads the stored database. With `If-None-Match` set to its ETag, responds 304 " +
    "if it hasn't changed.",
  request: { headers: databaseGetPreconditionSchema },
  errors: ["NOT_FOUND"],
  responses: {
    200: {
      description: "The stored database",
      headers: etagHeaders,
      content: { "application/octet-stream": { schema: databaseBlobBody } },
    },
    304: { description: "Not modified", headers: etagHeaders },
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
