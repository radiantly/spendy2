/**
 * Vitest global setup for the scripts' tests: the real worker, served over
 * HTTP for the scripts to talk to, with nothing kept on disk, and a
 * directory for what the tests write, removed when they're done. Tests read
 * both with `inject`.
 */
import fs from "fs";
import os from "os";
import path from "path";
import * as opaque from "@serenity-kit/opaque";
import type { TestProject } from "vitest/node";
import { unstable_startWorker } from "wrangler";

declare module "vitest" {
  interface ProvidedContext {
    /** The worker's URL. */
    endpoint: string;
    /** An empty directory, for the tests' files. */
    temporaryDirectory: string;
  }
}

export default async function setup(project: TestProject) {
  await opaque.ready;
  // The Vite plugin fills in the assets' directory when it builds the app;
  // on its own, wrangler needs one, and the scripts only use the API.
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "spendy-scripts-"));
  const assets = path.join(temporary, "assets");
  const temporaryDirectory = path.join(temporary, "tests");
  fs.mkdirSync(assets);
  fs.mkdirSync(temporaryDirectory);
  const worker = await unstable_startWorker({
    config: path.join(import.meta.dirname, "..", "..", "workers", "spendy2", "wrangler.jsonc"),
    assets,
    bindings: {
      OPAQUE_SERVER_SETUP: { type: "plain_text", value: opaque.server.createSetup() },
    },
    dev: {
      server: { port: 0 },
      inspector: false,
      persist: false,
      watch: false,
      liveReload: false,
      logLevel: "warn",
    },
  });
  await worker.ready;
  project.provide("endpoint", String(await worker.url));
  project.provide("temporaryDirectory", temporaryDirectory);

  return async () => {
    await worker.dispose();
    fs.rmSync(temporary, { recursive: true, force: true });
  };
}
