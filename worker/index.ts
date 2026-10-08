import { Hono } from "hono";
import * as opaque from "@serenity-kit/opaque";
import users from "./routes/users.ts";
import auth from "./routes/auth.ts";

const app = new Hono<{ Bindings: Env }>().basePath("/api");
app.route("/users", users);
app.route("/auth", auth);

app.get("/", async (c) => {
  await opaque.ready;

  const { registrationRequest } = opaque.client.startRegistration({
    password: "test123",
  });

  const { registrationResponse } = opaque.server.createRegistrationResponse({
    serverSetup: c.env.OPAQUE_SERVER_SETUP,
    userIdentifier: "hi there",
    registrationRequest,
  });

  return Response.json({
    name: "Cloudflare",
    registrationResponse,
  });
});

export default app;
export { UserStore } from "./durable-objects/UserStore.ts";
