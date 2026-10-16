import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import * as opaque from "@serenity-kit/opaque";
import type { BrowserCommand } from "vitest/node";

await opaque.ready;

/**
 * Moves the real mouse to a point in the test page's viewport, then presses
 * or releases the left button there. userEvent only clicks and drags whole
 * elements; tests of drag selection need the steps in between.
 */
const mouse: BrowserCommand<[action: "move" | "down" | "up", x: number, y: number]> = async (
  context,
  action,
  x,
  y,
) => {
  if (context.provider.name !== "playwright") throw new Error("mouse needs Playwright");
  const frame = await context.frame();
  // The test page is an iframe in the runner's page, possibly scaled down to fit.
  const box = (await (await frame.frameElement()).boundingBox())!;
  const scale = box.width / ((await frame.evaluate("innerWidth")) as number);
  await context.page.mouse.move(box.x + x * scale, box.y + y * scale);
  if (action === "down") await context.page.mouse.down();
  if (action === "up") await context.page.mouse.up();
};

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
            commands: { mouse },
          },
        },
      },
    ],
  },
});
