import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requireAuth } from "../../middleware/requireAuth.ts";
import { sValidator } from "@hono/standard-validator";
import {
  databaseBlobSchema,
  databaseEtagSchema,
  databaseGetPreconditionSchema,
  databasePutPreconditionSchema,
  toSha256Schema,
} from "../../schemas.ts";
import { env } from "cloudflare:workers";
import type { ContentfulStatusCode } from "hono/utils/http-status";

const database = new Hono<{ Bindings: Env }>();

database.put(
  "/",
  requireAuth,
  bodyLimit({ maxSize: env.MAX_DATABASE_UPLOAD_BYTES }),
  sValidator("header", databasePutPreconditionSchema),
  async (c) => {
    const precondition = c.req.valid("header");

    const body = await c.req.arrayBuffer();
    const validationResult = databaseBlobSchema.safeDecode(body);
    if (!validationResult.success) return c.json({ error: validationResult.error }, 400);

    const sha256 = await toSha256Schema.decodeAsync(body);

    const userStore = c.env.USER.getByName(c.var.username);
    const result = await userStore.uploadDatabase(c.var.sessionId, precondition, body, sha256);
    if (!result.success) {
      const STATUS: Record<typeof result.code, ContentfulStatusCode> = {
        UNAUTHORIZED: 401,
        PRECONDITION_FAILED: 412,
        STORAGE_ERROR: 502,
      };
      return c.json({ error: result.code }, STATUS[result.code]);
    }

    return c.body(null, 204, {
      ETag: databaseEtagSchema.encode(sha256),
    });
  },
);

database.get("/", requireAuth, sValidator("header", databaseGetPreconditionSchema), async (c) => {
  const userStore = c.env.USER.getByName(c.var.username);
  const result = await userStore.downloadDatabase(
    c.var.sessionId,
    c.req.valid("header")["if-none-match"],
  );
  if (!result.success) {
    const STATUS: Record<typeof result.code, ContentfulStatusCode> = {
      UNAUTHORIZED: 401,
      NOT_FOUND: 404,
      STORAGE_ERROR: 502,
    };
    return c.json({ error: result.code }, STATUS[result.code]);
  }

  if (!result.modified)
    return c.body(null, 304, { ETag: databaseEtagSchema.encode(result.sha256) });

  return c.body(result.body, 200, {
    "Content-Type": "application/octet-stream",
    ETag: databaseEtagSchema.encode(result.sha256),
  });
});

export default database;
