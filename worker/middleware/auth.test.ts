import { Hono } from "hono";
import { describe, expectTypeOf, it } from "vitest";
import { requireAuth } from "./auth.ts";

// these only check types, tsc fails if they are wrong
describe("requireAuth", () => {
  it("exposes the token contents to handlers after it", () => {
    new Hono<{ Bindings: Env }>().post("/", requireAuth, (c) => {
      expectTypeOf(c.var.username).toEqualTypeOf<string>();
      expectTypeOf(c.var.sessionId).toEqualTypeOf<string>();
      return c.body(null);
    });
  });

  it("does not expose the token contents to handlers without it", () => {
    new Hono<{ Bindings: Env }>().post("/", (c) => {
      // @ts-expect-error username is only set by requireAuth
      void c.var.username;
      // @ts-expect-error sessionId is only set by requireAuth
      void c.var.sessionId;
      return c.body(null);
    });
  });
});
