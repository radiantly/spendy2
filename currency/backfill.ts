/**
 * Builds the currency worker's assets from nothing: every rate Frankfurter
 * has, deployed in place of whatever the worker had. It is how the worker
 * gets its history, and how its rates are put right: the assets are the ones
 * the daily update (see cron/update.ts) would have come to, and it carries
 * on from them.
 */
import { deployAssets, type Account, type DeployStats } from "./assets.ts";
import { FIRST_DAY, dateOf, dayOf } from "./chunks.ts";
import { type Rate } from "./format.ts";
import { FrankfurterError, fetchRates } from "./frankfurter.ts";
import { planAll } from "./plan.ts";

/** How many times a slice is asked for again when Frankfurter is busy. */
const RETRIES = 5;
/** The seconds to wait before asking again, when Frankfurter doesn't say. */
const RETRY_AFTER = 10;

export type Slice = { from: string; to: string; rates: number };

export type BackfillOptions = {
  /** Told of each slice of rates as it's read. */
  onSlice?: (slice: Slice) => void;
  /** Waits out the seconds Frankfurter asked for. */
  wait?: (seconds: number) => Promise<void>;
};

export type Backfill = {
  rates: number;
  /** The rows of Frankfurter's that weren't a rate to write. */
  skipped: unknown[];
  currencies: number;
  /** The assets deployed, the manifest among them. */
  assets: number;
  deploy: DeployStats;
};

/** The calendar years from `FIRST_DAY` to `day`, each as its first and last day there. */
export function slices(day: number) {
  const years: { from: number; to: number }[] = [];
  const lastYear = Number(dateOf(day).slice(0, 4));
  for (let year = Number(dateOf(FIRST_DAY).slice(0, 4)); year <= lastYear; year += 1)
    years.push({
      from: Math.max(FIRST_DAY, dayOf(`${year}-01-01`)!),
      to: Math.min(day, dayOf(`${year}-12-31`)!),
    });
  return years;
}

/** A slice's rates, asked for again after a wait for as long as Frankfurter is busy. */
async function sliceRates(from: number, to: number, wait: (seconds: number) => Promise<void>) {
  for (let retries = 0; ; retries += 1) {
    try {
      return await fetchRates(from, to);
    } catch (error) {
      const busy = error instanceof FrankfurterError && [429, 503].includes(error.status);
      if (!busy || retries === RETRIES) throw error;
      await wait(error.retryAfter ?? RETRY_AFTER);
    }
  }
}

function sleep(seconds: number) {
  return new Promise<void>((done) => setTimeout(done, seconds * 1000));
}

/**
 * Makes the assets of the worker `scriptName` every rate Frankfurter has to
 * `day`. The rates are read a year at a time, one after the other, so as to
 * go easy on Frankfurter. Nothing is deployed unless every year was read.
 */
export async function backfill(
  account: Account,
  scriptName: string,
  day: number,
  { onSlice, wait = sleep }: BackfillOptions = {},
): Promise<Backfill> {
  const rates: Rate[] = [];
  const skipped: unknown[] = [];
  for (const { from, to } of slices(day)) {
    const slice = await sliceRates(from, to, wait);
    for (const rate of slice.rates) rates.push(rate);
    for (const row of slice.skipped) skipped.push(row);
    onSlice?.({ from: dateOf(from), to: dateOf(to), rates: slice.rates.length });
  }

  const planned = await planAll(rates, day);
  const deploy = await deployAssets(account, scriptName, planned.assets, planned.files);
  return {
    rates: rates.length,
    skipped,
    currencies: planned.manifest.currencies.length,
    assets: Object.keys(planned.assets).length,
    deploy,
  };
}
