import { OpenAPIHono } from "@hono/zod-openapi";
import pkg from "../../package.json" with { type: "json" };
import users from "./routes/users/index.ts";
import { databaseTag } from "./routes/users/database.ts";
import auth, { authTag } from "./routes/auth.ts";

const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api");

app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
});
app.route("/users", users);
app.route("/auth", auth);

/**
 * What the OpenAPI document says besides the routes, given the database's
 * CREATE TABLE statements, which only Node can work out; see document.ts.
 */
export function openAPIDocumentFor(databaseTables: string[]) {
  return {
    info: {
      title: "Spendy2",
      version: pkg.version,
      description: `
Spendy2 is an end-to-end encrypted personal finance dashboard that does two things:
- It stores details of your transactions in an encrypted database.
- The frontend decrypts this database to provide a dashboard view and easy edit access.

Most importantly, it does NOT handle the actual import of data. Parsing transactions from a pdf
statement, bank API, or any other source and adding it to the database will need to be handled by you.
      `,
    },
    // in the order they're listed
    tags: [authTag, databaseTag(databaseTables)],
  };
}

export default app;
