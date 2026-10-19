import { OpenAPIHono } from "@hono/zod-openapi";
import users from "./routes/users/index.ts";
import auth from "./routes/auth.ts";

const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api");

app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
});
app.route("/users", users);
app.route("/auth", auth);

export default app;
