import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import * as opaque from "@serenity-kit/opaque";

await opaque.ready;

export default defineConfig({
  test: {
    projects: [
      {
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
        test: {
          name: "worker",
          include: ["worker/**/*.test.ts", "src/api/**/*.test.ts"],
        },
      },
      {
        // Same as vite.config.ts, minus the Cloudflare plugin.
        plugins: [react(), tailwindcss(), babel({ presets: [reactCompilerPreset()] })],
        worker: { format: "es" },
        test: {
          name: "browser",
          include: ["src/**/*.test.{ts,tsx}"],
          exclude: ["src/api/**"],
          setupFiles: ["src/test/setup.ts"],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
