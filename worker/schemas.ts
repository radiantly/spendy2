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
