import type { RouteConfig } from "@hono/zod-openapi";
import { bearerAuth } from "hono/bearer-auth";
import type { MiddlewareHandler } from "hono";
import { tokenSchema, type Token } from "../schemas.ts";
import { createApiRoute, type ErrorCode } from "../openapi.ts";

const requireAuth = bearerAuth<{
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
  invalidToken: { message: { error: "UNAUTHORIZED" } },
});

/** A route's own middleware, as a tuple. */
type MiddlewareOf<R> = R extends { middleware: infer M }
  ? M extends readonly unknown[]
    ? M
    : [M]
  : [];

/**
 * Like createApiRoute, for a route only logged in users can call: requireAuth
 * runs before the route's own middleware, and the route documents it.
 */
export function createAuthenticatedRoute<
  const R extends RouteConfig,
  const C extends ErrorCode = never,
>(config: R & { errors?: readonly C[] }) {
  const { middleware, errors = [], ...rest } = config;
  const codes: (C | "UNAUTHORIZED")[] = [...errors, "UNAUTHORIZED"];
  return createApiRoute({
    ...rest,
    middleware: [requireAuth, ...([] as MiddlewareHandler[]).concat(middleware ?? [])] as [
      typeof requireAuth,
      ...MiddlewareOf<R>,
    ],
    // app.ts registers the scheme
    security: [{ bearerAuth: [] }],
    errors: codes,
  });
}
