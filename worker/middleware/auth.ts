import { bearerAuth } from "hono/bearer-auth";
import { tokenSchema, type Token } from "../schemas.ts";

export const requireAuth = bearerAuth<{
  Bindings: Env;
  Variables: Token;
}>({
  verifyToken: (tokenStr, c) => {
    const result = tokenSchema.safeDecode(tokenStr);
    if (!result.success) return false;

    c.set("username", result.data.username);
    c.set("sessionId", result.data.sessionId);
    return true;
  },
  noAuthenticationHeader: { message: { error: "UNAUTHORIZED" } },
  invalidAuthenticationHeader: { message: { error: "INVALID_REQUEST" } },
  invalidToken: { message: { error: "UNAUTHORIZED" } },
});
