/**
 * The daily update of the currency worker's rates (see CURRENCY_PLAN.md): it
 * reads the manifest, the states of the keys a week back from today is in,
 * and that week of Frankfurter's rates, writes the rates into the states, and
 * deploys what changed.
 *
 * Running it again does no harm: it comes to the same assets from the same
 * rates, and deploys nothing when they are the ones already there.
 */
import { deployAssets, type DeployStats } from "../assets.ts";
import { dateOf, today } from "../chunks.ts";
import { MANIFEST_PATH, statePath, type Manifest } from "../format.ts";
import { fetchRates } from "../frankfurter.ts";
import { WINDOW_DAYS, plan, windowKeys } from "../plan.ts";

export type Update = {
  /** The day the update was of: the last of its window. */
  date: string;
  rates: number;
  /** The rows of Frankfurter's that weren't a rate to write. */
  skipped: number;
  currencies: number;
  /** What the deploy took, or null when there was nothing to deploy. */
  deploy: DeployStats | null;
};

/** An asset of the currency worker, as it's served now. */
async function asset(env: Env, path: string) {
  const response = await fetch(`${env.CURRENCY_ORIGIN}${path}`);
  if (!response.ok) throw new Error(`Reading ${path}: ${response.status}`);
  return response;
}

/** Runs the update for the window ending on `day`, and gives what it came to. */
export async function update(env: Env, day = today()): Promise<Update> {
  const manifest = await (await asset(env, MANIFEST_PATH)).json<Manifest>();
  const keys = windowKeys(day).filter((key) => manifest.assets[statePath(key)] !== undefined);
  const [{ rates, skipped }, ...stateResponses] = await Promise.all([
    fetchRates(day - WINDOW_DAYS, day),
    ...keys.map((key) => asset(env, statePath(key))),
  ]);
  if (skipped.length > 0)
    console.warn(`Skipped ${skipped.length} of Frankfurter's rows, such as`, skipped.slice(0, 5));

  const states = new Map<number, Uint8Array>();
  for (const [index, key] of keys.entries())
    states.set(key, new Uint8Array(await stateResponses[index]!.arrayBuffer()));

  const planned = await plan(manifest, states, rates, day);
  const deploy = planned.changed
    ? await deployAssets(
        { accountId: env.CLOUDFLARE_ACCOUNT_ID, apiToken: env.CLOUDFLARE_API_TOKEN },
        env.CURRENCY_SCRIPT,
        planned.assets,
        planned.files,
      )
    : null;

  return {
    date: dateOf(day),
    rates: rates.length,
    skipped: skipped.length,
    currencies: planned.manifest.currencies.length,
    deploy,
  };
}
