/**
 * Deploys the currency worker's rates from nothing (see workers/currency/backfill.ts):
 * every rate Frankfurter has, in place of whatever the worker had. Run it to
 * set the worker up, and again whenever its rates need putting right; the
 * daily update carries on from what it leaves.
 *
 * It needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, a token that may
 * edit the worker's script: from the environment, or else from
 * workers/currency/.env.
 *
 *   npm run deploy:currency
 */
import path from "path";
import { intro, log, outro, spinner } from "@clack/prompts";
import { backfill } from "../workers/currency/backfill.ts";
import { today } from "../workers/currency/chunks.ts";
import { fail, readEnv } from "./lib/lib.ts";

/** The currency worker's name, as workers/currency/wrangler.jsonc has it. */
const SCRIPT = "currency";

const ENV_PATH = path.join(import.meta.dirname, "..", "workers", "currency", ".env");

intro("Backfill currency rates");

const env = { ...readEnv(ENV_PATH), ...process.env };
const accountId = env.CLOUDFLARE_ACCOUNT_ID;
const apiToken = env.CLOUDFLARE_API_TOKEN;
if (!accountId || !apiToken)
  fail(
    "Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, in the environment or in workers/currency/.env",
  );

const progress = spinner();
progress.start("Reading Frankfurter's rates");
try {
  const result = await backfill({ accountId, apiToken }, SCRIPT, today(), {
    onSlice: ({ from, rates }) =>
      progress.message(`Read ${from.slice(0, 4)}: ${rates} rates. Reading on`),
  });
  progress.stop(`Read ${result.rates} rates of ${result.currencies} currencies`);
  if (result.skipped.length > 0)
    log.warn(
      `Left out ${result.skipped.length} rows that weren't rates, such as ` +
        JSON.stringify(result.skipped.slice(0, 5)),
    );
  const megabytes = (result.deploy.uploadedBytes / 2 ** 20).toFixed(1);
  outro(
    `Deployed ${result.assets} assets, uploading ${result.deploy.uploadedFiles} (${megabytes} MiB)`,
  );
} catch (error) {
  progress.stop("Stopped");
  fail(error instanceof Error ? error.message : String(error));
}
