import { z } from "zod";

export const usernameSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[a-z0-9]+$/);

const latin1Base64Schema = z.codec(z.base64(), z.string(), {
  decode: (b64) => atob(b64),
  encode: (str) => btoa(str),
});

const tokenUnencodedSchema = z.codec(
  z.string().includes(":"),
  z.strictObject({
    username: usernameSchema,
    sessionId: z.uuidv4(),
  }),
  {
    decode: (tokenStr) => {
      const i = tokenStr.indexOf(":");
      return {
        username: tokenStr.slice(0, i),
        sessionId: tokenStr.slice(i + 1),
      };
    },
    encode: ({ username, sessionId }) => `${username}:${sessionId}`,
  },
);

export const tokenSchema = latin1Base64Schema.pipe(tokenUnencodedSchema);
export type Token = z.infer<typeof tokenSchema>;

export const databaseEtagSchema = z.codec(z.string().regex(/^".{64}"$/), z.hash("sha256"), {
  decode: (etag) => etag.slice(1, -1),
  encode: (hash) => `"${hash}"`,
});

/**
 * The socket a client watches the database with (see routes/users/updates.ts):
 * the first message it sends is `databaseUpdatesAuthSchema`, and each it's
 * sent is a `databaseUpdateSchema`.
 */
export const databaseUpdatesAuthSchema = z.strictObject({ token: z.string() });

/**
 * The database's last part: its index, counting from 0, and its sha256 (the
 * database's ETag). Null without a database.
 */
export const databaseUpdateSchema = z.strictObject({
  latestPart: z.strictObject({ index: z.int().nonnegative(), hash: z.hash("sha256") }).nullable(),
});

/** The codes the server closes a database updates socket with. */
export const DATABASE_UPDATES_CLOSE = {
  /** The token isn't for an active session of the user, or the session has ended since. */
  UNAUTHORIZED: 4401,
  /** No token came in time. */
  AUTH_TIMEOUT: 4408,
} as const;
