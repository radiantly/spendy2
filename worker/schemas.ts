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

export const databasePutPreconditionSchema = z.union([
  z.object({
    "if-match": databaseEtagSchema,
    "if-none-match": z.never().optional(),
  }),
  z.object({
    "if-match": z.never().optional(),
    "if-none-match": z.literal("*"),
  }),
]);

export type DatabasePutPrecondition = z.infer<typeof databasePutPreconditionSchema>;

export const databaseGetPreconditionSchema = z.object({
  "if-none-match": databaseEtagSchema.optional(),
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
