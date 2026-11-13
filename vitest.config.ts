import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { playwright } from "@vitest/browser-playwright";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import * as opaque from "@serenity-kit/opaque";
import type { BrowserCommand } from "vitest/node";
import { opaqueWorkerd } from "./vite-plugins/opaqueWorkerd.ts";

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

/**
 * Waits for the test page's next download, then gives its file's name and
 * bytes (as numbers: a command's result is sent as JSON). Start it before
 * whatever downloads the file.
 */
const nextDownload: BrowserCommand<[]> = async (context) => {
  if (context.provider.name !== "playwright") throw new Error("nextDownload needs Playwright");
  const download = await context.page.waitForEvent("download");
  const bytes = await readFile(await download.path());
  return { name: download.suggestedFilename(), bytes: [...bytes] };
};

/**
 * Emulates what the user prefers, for media queries in the test page: the
 * features given, each null to go back to the browser's own.
 */
const emulateMedia: BrowserCommand<
  [
    media: {
      colorScheme?: "light" | "dark" | null;
      reducedMotion?: "reduce" | "no-preference" | null;
    },
  ]
> = async (context, media) => {
  if (context.provider.name !== "playwright") throw new Error("emulateMedia needs Playwright");
  await context.page.emulateMedia(media);
};

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          opaqueWorkerd(),
          cloudflareTest({
            wrangler: { configPath: "./workers/spendy2/wrangler.jsonc" },
            miniflare: {
              bindings: {
                OPAQUE_SERVER_SETUP: opaque.server.createSetup(),
                // So a test can see a socket time out without waiting the real
                // time, and still has the time to upload before it authenticates.
                SOCKET_AUTH_TIMEOUT_SECONDS: 1,
              },
            },
          }),
        ],
        test: {
          name: "spendy2",
          include: ["workers/spendy2/**/*.test.ts", "src/api/**/*.test.ts"],
        },
      },
      {
        // The currency rates' cron worker, with made-up secrets: its tests
        // stub every request it makes.
        plugins: [
          cloudflareTest({
            wrangler: { configPath: "./workers/currency/wrangler.jsonc" },
            miniflare: {
              bindings: { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_API_TOKEN: "token" },
            },
          }),
        ],
        test: {
          name: "currency",
          include: ["workers/currency/**/*.test.ts"],
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
            instances: [{ browser: "chromium" }, { browser: "firefox" }, { browser: "webkit" }],
            commands: { mouse, nextDownload, emulateMedia },
          },
        },
      },
      {
        // The scripts, run as processes of their own against the real worker.
        test: {
          name: "scripts",
          include: ["scripts/**/*.test.ts"],
          globalSetup: ["scripts/test/globalSetup.ts"],
          // Each test has a user and a directory of its own, so they can run
          // side by side. They start Node a few times over, though, which
          // is work for a core: more at once than there are cores only
          // makes each slower, until they time out.
          testTimeout: 30_000,
          sequence: { concurrent: true },
          maxConcurrency: Math.min(8, availableParallelism()),
        },
      },
    ],
  },
});
