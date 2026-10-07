import * as opaque from "@serenity-kit/opaque";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      // wait for opaque to be available
      await opaque.ready;

      const { registrationRequest } = opaque.client.startRegistration({
        password: "test123",
      });

      const { registrationResponse } = opaque.server.createRegistrationResponse(
        {
          serverSetup: env.OPAQUE_SERVER_SETUP,
          userIdentifier: "hi there",
          registrationRequest,
        },
      );

      return Response.json({
        name: "Cloudflare",
        registrationResponse,
      });
    }

    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
