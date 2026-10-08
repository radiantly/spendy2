import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import * as opaque from "@serenity-kit/opaque";

await opaque.ready;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { OPAQUE_SERVER_SETUP: opaque.server.createSetup() },
      },
    }),
  ],
  test: { include: ["worker/**/*.test.ts"] },
});
