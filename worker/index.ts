import { Hono } from "hono";
import * as opaque from "@serenity-kit/opaque";

const app = new Hono<{ Bindings: Env }>();

app.get("/api", async (c) => {
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
