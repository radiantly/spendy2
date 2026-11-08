import { OpenAPIHono } from "@hono/zod-openapi";
import { endTime, startTime, timing } from "hono/timing";
import { z } from "zod";
import { createAuthenticatedRoute } from "../../middleware/requireAuth.ts";
import { databaseEtagSchema } from "../../schemas.ts";
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

const PART_FORMAT =
  "Each part is `SPENDY` + `02` + length (4 bytes) + wrapped key (40 bytes) + AAD (36 bytes) " +
  "+ nonce (12 bytes) + AES-GCM(gzip(content)), its 16-byte tag included. The length is the " +
  "whole part's. The AAD is the sha256 of the part before it (all zeros for part 0) + the " +
  "user version of its content. Part 0's content is an SQLite database, and each part after " +
  "it a changeset to apply on top. Integers are unsigned and little-endian.";

/** Documents a body of parts; the user store checks it itself. */
function partsBody(description: string) {
  return z.instanceof(ArrayBuffer).meta({ type: "string", format: "binary", description });
}

const etagHeaders = z.object({
  ETag: databaseEtagSchema,
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
  summary: "Replace the database",
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

const appendHeadersSchema = z.object({
  "if-match": databaseEtagSchema.meta({
    description:
      "The ETag of the database the part is added to, from the corresponding GET call or the upload that last changed it.",
  }),
});

const appendDatabasePart = createAuthenticatedRoute({
  method: "post",
  path: "/parts",
  tags: [DATABASE_TAG],
  summary: "Add a changeset",
  description:
    "Adds a part after the last one. Its AAD must hold the last part's sha256, the same as " +
    "`If-Match`, and its user version can't be lower than that part's. Only a PUT can create " +
    "the database.",
  middleware: [timing()],
  request: {
    headers: appendHeadersSchema,
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
    "BROKEN_PART_CHAIN",
    "USER_VERSION_DECREASED",
    "PRECONDITION_FAILED",
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
  const result = await userStore.appendDatabasePart(
    c.var.sessionId,
    body,
    c.req.valid("header")["if-match"],
  );
  endTime(c, "store");

  if (!result.success) return fixedResponse(c, result.code);

  return fixedResponse(c, "NO_CONTENT", { ETag: databaseEtagSchema.encode(result.sha256) });
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

export const databaseGetPreconditionSchema = z.object({
  "if-none-match": databaseEtagSchema.optional(),
});

const downloadDatabase = createAuthenticatedRoute({
  method: "get",
  path: "/parts",
  tags: [DATABASE_TAG],
  summary: "Download the database",
  description:
    "Downloads every part, one after the other. The ETag is the sha256 of the last part. " +
    "With `If-None-Match` set to it, responds 304 if the database hasn't changed.",
  request: { headers: databaseGetPreconditionSchema },
  errors: ["NOT_FOUND"],
  responses: {
    200: {
      description: "The stored database",
      headers: etagHeaders,
      content: {
        "application/octet-stream": {
          schema: partsBody(`Every part, one after the other. ${PART_FORMAT}`),
        },
      },
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

  return c.body(withLength(result), 200, {
    "Content-Type": "application/octet-stream",
    ETag: databaseEtagSchema.encode(result.sha256),
  });
});

/** A part's position, from 0, as written in a path. */
const partIndexSchema = z.codec(z.string().regex(/^(0|[1-9][0-9]*)$/), z.int().nonnegative(), {
  decode: Number,
  encode: String,
});

const downloadDatabasePart = createAuthenticatedRoute({
  method: "get",
  path: "/parts/{part}",
  tags: [DATABASE_TAG],
  summary: "Download a part",
  description: "Downloads one part, counting from 0. The ETag is its sha256.",
  request: {
    params: z.object({
      part: partIndexSchema.meta({ description: "The part's position, from 0" }),
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
  const result = await userStore.downloadDatabasePart(c.var.sessionId, c.req.valid("param").part);
  if (!result.success) return fixedResponse(c, result.code);

  return c.body(withLength(result), 200, {
    "Content-Type": "application/octet-stream",
    ETag: databaseEtagSchema.encode(result.sha256),
  });
});

export default database;
