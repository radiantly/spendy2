import { OpenAPIHono } from "@hono/zod-openapi";
import { endTime, startTime, timing } from "hono/timing";
import { z } from "zod";
import { createAuthenticatedRoute } from "../../middleware/requireAuth.ts";
import { databaseEtagSchema } from "../../schemas.ts";
import { fixedResponse } from "../../openapi.ts";
import { PART_FORMAT } from "../../databaseParts.ts";

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

/** Documents a body of parts; the user store checks it itself. */
function partsBody(description: string) {
  return z.instanceof(ArrayBuffer).meta({ type: "string", format: "binary", description });
}

const etagHeaders = z.object({
  ETag: databaseEtagSchema,
});

/**
 * A body the user store streams, sent with its Content-Length. If the stream
 * errors, so does the response, partway through its body.
 */
function withLength({
  body,
  byteLength,
}: {
  body: ReadableStream<Uint8Array>;
  byteLength: number;
}) {
  return body.pipeThrough(new FixedLengthStream(byteLength));
}

const downloadDatabase = createAuthenticatedRoute({
  method: "get",
  path: "/parts",
  tags: [DATABASE_TAG],
  summary: "Get database",
  description:
    "The database is stored as a list of parts. Part 0 is the base SQLite database, while parts 1+ are changesets that must be applied on top of the base database.",
  request: {
    headers: z.object({
      "if-none-match": databaseEtagSchema.optional(),
    }),
  },
  errors: ["NOT_FOUND"],
  responses: {
    200: {
      description: "All database parts, concatenated.",
      headers: etagHeaders,
      content: {
        "application/octet-stream": {
          schema: partsBody(
            `The format for a single part:\n\n${PART_FORMAT}\n\nUse the length field to determine where a part ends and the next begins.`,
          ),
        },
      },
    },
    304: { description: "Not modified.", headers: etagHeaders },
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

  return c.body(withLength(result), 200, {
    "Content-Type": "application/octet-stream",
    ETag: databaseEtagSchema.encode(result.sha256),
  });
});

const appendDatabasePart = createAuthenticatedRoute({
  method: "post",
  path: "/parts",
  tags: [DATABASE_TAG],
  summary: "Add database part",
  description:
    "Use this to add a database part. When the database is edited, this API can be used to upload the changeset. The part must follow the database's last part: its AAD holds that part's sha256 (the database's ETag), and its user version is no lower. A part that doesn't follow it, as when the database has changed since the part was made, gets a 409 CONFLICT. If a database does not exist (part 0) use the [PUT API](#tag/database/GET/api/users/me/database/parts/{part}/tag/database/PUT/api/users/me/database/parts) instead.",
  middleware: [timing()],
  request: {
    body: {
      required: true,
      content: {
        "application/octet-stream": { schema: partsBody(`Exactly one part. ${PART_FORMAT}`) },
      },
    },
  },
  errors: [
    "MISSING_SPENDY_MAGIC",
    "INVALID_VERSION_BYTE",
    "INVALID_PART_LENGTH",
    "USER_VERSION_DECREASED",
    "CONFLICT",
  ],
  responses: {
    204: { description: "The part is now the database's last part", headers: etagHeaders },
  },
});

database.openapi(appendDatabasePart, async (c) => {
  const body = c.req.raw.body;
  if (body === null) return fixedResponse(c, "MISSING_SPENDY_MAGIC");

  const userStore = c.env.USER.getByName(c.var.username);

  // the body is streamed to the user store as it arrives
  startTime(c, "store", "Receiving and storing it");
  const result = await userStore.appendDatabasePart(c.var.sessionId, body);
  endTime(c, "store");

  if (!result.success) return fixedResponse(c, result.code);

  return fixedResponse(c, "NO_CONTENT", { ETag: databaseEtagSchema.encode(result.sha256) });
});

/**
 * A part's position, from 0, as written in a path: digits only, without
 * leading zeros. Path parameters arrive as strings, so it's decoded here, and
 * documented as the integer it decodes to rather than as the pattern.
 */
const partIndexSchema = z
  .codec(z.string().regex(/^(0|[1-9][0-9]*)$/), z.int().nonnegative(), {
    decode: Number,
    encode: String,
  })
  .meta({ type: "integer", minimum: 0 });

const downloadDatabasePart = createAuthenticatedRoute({
  method: "get",
  path: "/parts/{index}",
  tags: [DATABASE_TAG],
  summary: "Get database part",
  description: "Downloads one part, counting from 0. The ETag is its sha256.",
  request: {
    params: z.object({
      index: partIndexSchema.meta({ description: "The part's position, from 0" }),
    }),
  },
  errors: ["NOT_FOUND"],
  responses: {
    200: {
      description: "The part",
      headers: etagHeaders,
      content: { "application/octet-stream": { schema: partsBody(PART_FORMAT) } },
    },
  },
});

database.openapi(downloadDatabasePart, async (c) => {
  const userStore = c.env.USER.getByName(c.var.username);
  const result = await userStore.downloadDatabasePart(c.var.sessionId, c.req.valid("param").index);
  if (!result.success) return fixedResponse(c, result.code);

  return c.body(withLength(result), 200, {
    "Content-Type": "application/octet-stream",
    ETag: databaseEtagSchema.encode(result.sha256),
  });
});

const replaceHeadersSchema = z
  .object({
    "if-match": databaseEtagSchema.optional().meta({
      description:
        "If the user has an existing database, this header is required. Pass the ETag from the corresponding GET call for the value of this header.",
    }),
    "if-none-match": z.literal("*").optional().meta({
      description:
        "If the user does NOT have an existing database, this header is required. Pass `*` for the value of this header.",
    }),
  })
  .refine(
    (headers) => (headers["if-match"] === undefined) !== (headers["if-none-match"] === undefined),
    { error: "Needs exactly one of If-Match and If-None-Match" },
  );

const replaceDatabase = createAuthenticatedRoute({
  method: "put",
  path: "/parts",
  tags: [DATABASE_TAG],
  summary: "Put database",
  description:
    "Replaces all of the database's parts with the ones uploaded, or creates the database. " +
    "Each part must follow the one before it: its AAD holds that part's sha256, and its user " +
    "version is no lower.",
  middleware: [timing()],
  request: {
    headers: replaceHeadersSchema,
    body: {
      required: true,
      content: {
        "application/octet-stream": {
          schema: partsBody(`One or more parts, one after the other. ${PART_FORMAT}`),
        },
      },
    },
  },
  errors: [
    "MISSING_SPENDY_MAGIC",
    "INVALID_VERSION_BYTE",
    "INVALID_PART_LENGTH",
    "BROKEN_PART_CHAIN",
    "USER_VERSION_DECREASED",
    "PRECONDITION_FAILED",
  ],
  responses: {
    204: { description: "The upload is now the stored database", headers: etagHeaders },
  },
});

database.openapi(replaceDatabase, async (c) => {
  const body = c.req.raw.body;
  if (body === null) return fixedResponse(c, "MISSING_SPENDY_MAGIC");

  const userStore = c.env.USER.getByName(c.var.username);

  // the body is streamed to the user store as it arrives
  startTime(c, "store", "Receiving and storing it");
  const result = await userStore.replaceDatabase(
    c.var.sessionId,
    body,
    c.req.valid("header")["if-match"] ?? null,
  );
  endTime(c, "store");

  if (!result.success) return fixedResponse(c, result.code);

  return fixedResponse(c, "NO_CONTENT", { ETag: databaseEtagSchema.encode(result.sha256) });
});

export default database;
