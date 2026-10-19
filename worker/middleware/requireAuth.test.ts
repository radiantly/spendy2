import { OpenAPIHono } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import { describe, expect, expectTypeOf, it } from "vitest";
import { createApiRoute } from "../openapi.ts";
import { createAuthenticatedRoute } from "./requireAuth.ts";

const responses = { 204: { description: "Done" } };

describe("createAuthenticatedRoute", () => {
  // these only check types, tsc fails if they are wrong
  it("exposes the token contents to the route's handler", () => {
    const route = createAuthenticatedRoute({ method: "post", path: "/", responses });
    new OpenAPIHono<{ Bindings: Env }>().openapi(route, (c) => {
      expectTypeOf(c.var.username).toEqualTypeOf<string>();
      expectTypeOf(c.var.sessionId).toEqualTypeOf<string>();
      return c.body(null, 204);
    });
  });

  it("exposes the token contents alongside the route's own middleware's", () => {
    const route = createAuthenticatedRoute({
      method: "post",
      path: "/",
      middleware: [createMiddleware<{ Variables: { extra: number } }>((_c, next) => next())],
      responses,
    });
    new OpenAPIHono<{ Bindings: Env }>().openapi(route, (c) => {
      expectTypeOf(c.var.username).toEqualTypeOf<string>();
      expectTypeOf(c.var.extra).toEqualTypeOf<number>();
      return c.body(null, 204);
    });
  });

  it("does not expose the token contents to other routes", () => {
    const route = createApiRoute({ method: "post", path: "/", responses });
    new OpenAPIHono<{ Bindings: Env }>().openapi(route, (c) => {
      // @ts-expect-error username is only set by requireAuth
      void c.var.username;
      // @ts-expect-error sessionId is only set by requireAuth
      void c.var.sessionId;
      return c.body(null, 204);
    });
  });

  it("runs requireAuth before the route's own middleware", async () => {
    let ran = false;
    const route = createAuthenticatedRoute({
      method: "post",
      path: "/",
      middleware: [
        createMiddleware(async (_c, next) => {
          ran = true;
          await next();
        }),
      ],
      responses,
    });
    const app = new OpenAPIHono().openapi(route, (c) => c.body(null, 204));

    const response = await app.request("/", { method: "POST" });

    expect(response.status).toBe(401);
    expect(ran).toBe(false);
  });

  it("documents the bearer requirement, and its 401 alongside the route's own", () => {
    const route = createAuthenticatedRoute({
      method: "post",
      path: "/",
      errors: ["INVALID_LOGIN", "UNAUTHORIZED", "NOT_FOUND"],
      responses,
    });
    const app = new OpenAPIHono().openapi(route, (c) => c.body(null, 204));

    const document = app.getOpenAPI31Document({
      openapi: "3.1.0",
      info: { title: "", version: "" },
    });

    expect(document.paths?.["/"]?.post).toMatchObject({
      security: [{ bearerAuth: [] }],
      responses: {
        401: {
          content: {
            "application/json": {
              schema: { properties: { error: { enum: ["INVALID_LOGIN", "UNAUTHORIZED"] } } },
            },
          },
        },
        404: {},
      },
    });
  });
});
