import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import app, { openAPIDocumentFor } from "./app.ts";
import { createApiRoute, fixedResponse } from "./openapi.ts";
import { DATABASE_TAG } from "./routes/users/database.ts";

describe("createApiRoute", () => {
  it("documents a response per status, naming the codes sent with it", () => {
    const route = createApiRoute({
      method: "post",
      path: "/",
      errors: ["RATE_LIMITED", "INVALID_REQUEST", "MISSING_SPENDY_MAGIC"],
      responses: { 204: { description: "Done" } },
    });
    const app = new OpenAPIHono().openapi(route, (c) => c.body(null, 204));

    const operation = app.getOpenAPI31Document({
      openapi: "3.1.0",
      info: { title: "", version: "" },
    }).paths?.["/"]?.post;

    expect(Object.keys(operation?.responses ?? {})).toEqual(["204", "400", "429"]);
    expect(operation?.responses?.[400]).toMatchObject({
      content: {
        "application/json": {
          schema: { properties: { error: { enum: ["INVALID_REQUEST", "MISSING_SPENDY_MAGIC"] } } },
        },
      },
    });
    expect(operation).not.toHaveProperty("errors");
  });
});

describe("fixedResponse", () => {
  const route = createApiRoute({
    method: "post",
    path: "/",
    errors: ["NOT_FOUND"],
    responses: { 204: { description: "Done" } },
  });

  it("responds to an error code with its status and an { error } body", async () => {
    const app = new OpenAPIHono().openapi(route, (c) => fixedResponse(c, "NOT_FOUND"));

    const response = await app.request("/", { method: "POST" });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "NOT_FOUND" });
  });

  it("responds to a body-less code with its status, its headers and no body", async () => {
    const app = new OpenAPIHono().openapi(route, (c) =>
      fixedResponse(c, "NO_CONTENT", { ETag: '"abc"' }),
    );

    const response = await app.request("/", { method: "POST" });

    expect(response.status).toBe(204);
    expect(response.headers.get("ETag")).toBe('"abc"');
    expect(response.body).toBeNull();
  });

  // checks types only, tsc fails if they are wrong
  it("only type-checks in handlers of routes that document the response", () => {
    const app = new OpenAPIHono();
    app.openapi(route, async (c) =>
      Math.random() ? fixedResponse(c, "NOT_FOUND") : fixedResponse(c, "NO_CONTENT"),
    );
    // @ts-expect-error the route doesn't document RATE_LIMITED
    app.openapi(route, (c) => fixedResponse(c, "RATE_LIMITED"));
    // @ts-expect-error the route doesn't document a 304
    app.openapi(route, (c) => fixedResponse(c, "NOT_MODIFIED"));
  });
});

describe("the OpenAPI document", () => {
  const tables = ["CREATE TABLE a (x)", "CREATE TABLE b (y)"];
  const document = app.getOpenAPI31Document({ ...openAPIDocumentFor(tables), openapi: "3.1.0" });

  // TODO: Websocket route needs to be properly documented.
  it.fails("documents every route", () => {
    const documented = Object.entries(document.paths ?? {}).flatMap(([path, operations]) =>
      Object.keys(operations).map((method) => `${method.toUpperCase()} ${path}`),
    );
    // a route is listed once per handler, its middleware included
    const routed = new Set(
      app.routes.map(({ method, path }) => `${method} ${path.replaceAll(/:(\w+)/g, "{$1}")}`),
    );
    expect(documented.toSorted()).toEqual([...routed].toSorted());
  });

  it("describes exactly the tags its operations use", () => {
    const used = new Set(
      Object.values(document.paths ?? {}).flatMap((operations) =>
        Object.values(operations).flatMap((operation) => operation.tags ?? []),
      ),
    );

    expect(document.tags?.map(({ name }) => name).toSorted()).toEqual([...used].toSorted());
    for (const tag of document.tags ?? []) expect(tag.description).toBeTruthy();
  });

  it("shows the database's tables in the Database tag", () => {
    const tag = document.tags?.find(({ name }) => name === DATABASE_TAG);

    expect(tag?.description).toContain("```sql\nCREATE TABLE a (x);\n\nCREATE TABLE b (y);\n```");
  });
});
