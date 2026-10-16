import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { endTime, startTime, timing } from "hono/timing";
import { requireAuth } from "../../middleware/requireAuth.ts";
import { sValidator } from "@hono/standard-validator";
import {
  databaseEtagSchema,
  databaseGetPreconditionSchema,
  databasePutHeadersSchema,
} from "../../schemas.ts";
import { env } from "cloudflare:workers";
import type { ContentfulStatusCode } from "hono/utils/http-status";

const database = new Hono<{ Bindings: Env }>();

database.put(
  "/",
  timing(),
  requireAuth,
  sValidator("header", databasePutHeadersSchema),
  bodyLimit({ maxSize: env.MAX_DATABASE_UPLOAD_BYTES }),
  async (c) => {
    const body = c.req.raw.body;
    if (body === null) return c.json({ error: "MISSING_SPENDY_MAGIC" }, 400);

    const userStore = c.env.USER.getByName(c.var.username);

    // the body is streamed to the user store as it arrives
    startTime(c, "store", "Receiving and storing it");
    const result = await userStore.uploadDatabase(c.var.sessionId, c.req.valid("header"), body);
    endTime(c, "store");

    if (!result.success) {
      const STATUS: Record<typeof result.code, ContentfulStatusCode> = {
        UNAUTHORIZED: 401,
        MISSING_SPENDY_MAGIC: 400,
        INVALID_VERSION_BYTE: 400,
        PRECONDITION_FAILED: 412,
      };
      return c.json({ error: result.code }, STATUS[result.code]);
    }

    return c.body(null, 204, {
      ETag: databaseEtagSchema.encode(result.sha256),
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
