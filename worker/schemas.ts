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

/** A database upload's headers: exactly one precondition, and how long it is. */
export const databasePutHeadersSchema = z
  .object({
    "if-match": databaseEtagSchema
      .optional()
      .meta({ description: "The ETag of the stored database this upload replaces" }),
    "if-none-match": z.literal("*").optional().meta({ description: "`*` for the first upload" }),
    "content-length": z.string().regex(/^\d+$/),
  })
  .refine(
    (headers) => (headers["if-match"] === undefined) !== (headers["if-none-match"] === undefined),
    { error: "Needs exactly one of If-Match and If-None-Match" },
  );

export const databaseGetPreconditionSchema = z.object({
  "if-none-match": databaseEtagSchema
    .optional()
    .meta({ description: "The ETag of a database the client already has" }),
});

// Body format: SPENDY + version byte + ?
// The rest is only read by clients; for v1 see src/db/blob.ts.
export const DATABASE_BLOB_MAGIC = new TextEncoder().encode("SPENDY");
export const DATABASE_BLOB_VERSION = 0x01;
export const databaseBlobSchema = z
  .instanceof(ArrayBuffer)
  .transform((buffer) => new Uint8Array(buffer))
  .refine((bytes) => DATABASE_BLOB_MAGIC.every((byte, i) => byte === bytes[i]), {
    error: "MISSING_SPENDY_MAGIC",
  })
  .refine((bytes) => bytes[DATABASE_BLOB_MAGIC.length] === DATABASE_BLOB_VERSION, {
    error: "INVALID_VERSION_BYTE",
  });

export const toSha256Schema = z.instanceof(ArrayBuffer).transform(async (buffer) => {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(digest));
  return hashArray.map((byte) => byte.toString(16).padStart(2, "0")).join("");
});
