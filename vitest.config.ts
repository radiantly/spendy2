import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import * as opaque from "@serenity-kit/opaque";

await opaque.ready;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          OPAQUE_SERVER_SETUP: opaque.server.createSetup(),
          S3_ENDPOINT: "https://s3.test.invalid",
          S3_REGION: "test-region",
          S3_BUCKET: "test-bucket",
          S3_ACCESS_KEY_ID: "test-access-key-id",
          S3_SECRET_ACCESS_KEY: "test-secret-access-key",
        },
      },
    }),
  ],
  test: { include: ["worker/**/*.test.ts"] },
});
