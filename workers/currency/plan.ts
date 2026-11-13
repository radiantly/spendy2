/**
 * Works out the assets the currency worker is to have (see format.ts) from
 * the ones it has and the rates to add to them.
 */
import type { AssetFile } from "./assets.ts";
import { chunkPath, position } from "./chunks.ts";
import {
  MANIFEST_PATH,
  contentHash,
  manifestBytes,
  patchState,
  stateKey,
  statePath,
  type AssetEntry,
  type Manifest,
  type Rate,
} from "./format.ts";

/**
 * The days back from today whose rates the daily update fetches and writes
 * again: Frankfurter's last decimals shift as its sources report, and a
 * day's rates may come out after that day's update ran.
 */
export const WINDOW_DAYS = 7;

const BINARY = "application/octet-stream";

/**
 * The keys of the days in the window ending on `day`, oldest first: one, or
 * two for the days after a new chunk has started. They are the keys with a
 * state.
 */
export function windowKeys(day: number) {
  const first = position(day - WINDOW_DAYS).key;
  const last = position(day).key;
  return first === last ? [last] : [first, last];
}

export type Plan = {
  /** The manifest to deploy. */
  manifest: Manifest;
  /**
   * The assets that may differ from the ones deployed, by path: the chunks
   * and states of the keys written to, and the manifest.
   */
  files: Map<string, AssetFile>;
  /** Every asset to deploy, the manifest among them. */
  assets: Record<string, AssetEntry>;
  /** Whether any asset differs from what the plan was made from. */
  changed: boolean;
};

/** `plan`, writing to `keys`, oldest first, in place of the window's. */
async function planKeys(
  manifest: Manifest,
  states: Map<number, Uint8Array>,
  rates: Rate[],
  day: number,
  keys: number[],
): Promise<Plan> {
  const withState = windowKeys(day);
  const assets = { ...manifest.assets };
  for (const path of Object.keys(assets)) {
    const key = stateKey(path);
    if (key !== undefined && !withState.includes(key)) delete assets[path];
  }

  const files = new Map<string, AssetFile>();
  const add = async (path: string, bytes: Uint8Array<ArrayBuffer>, contentType = BINARY) => {
    files.set(path, { bytes, contentType });
    return { hash: await contentHash(bytes), size: bytes.length };
  };

  // Oldest first: a currency new to two keys has the same place in each.
  let currencies = manifest.currencies;
  for (const key of keys) {
    const patched = patchState(
      { currencies, assets: manifest.assets },
      states.get(key),
      key,
      rates,
    );
    currencies = patched.currencies;
    for (const [slot, bytes] of patched.chunks.entries()) {
      if (bytes.length === 0) continue;
      const path = chunkPath(currencies[slot]!, key);
      assets[path] = await add(path, bytes);
    }
    // A key without a rate yet has no state, as it has no chunks.
    if (withState.includes(key) && patched.state.length > 0)
      assets[statePath(key)] = await add(statePath(key), patched.state);
  }

  const next: Manifest = { currencies, assets };
  const nextBytes = manifestBytes(next);
  return {
    manifest: next,
    files,
    assets: { ...assets, [MANIFEST_PATH]: await add(MANIFEST_PATH, nextBytes, "application/json") },
    // Assets keep their order from one manifest to the next, so the same
    // assets are the same text.
    changed: JSON.stringify(next) !== JSON.stringify(manifest),
  };
}

/**
 * What to deploy so that the assets `manifest` lists have `rates` too, the
 * rates being of the window ending on `day`. `states` are those of
 * `windowKeys(day)` that the manifest lists, by key. The state of a key no
 * longer in the window is dropped: its chunks are never written to again.
 */
export function plan(
  manifest: Manifest,
  states: Map<number, Uint8Array>,
  rates: Rate[],
  day: number,
) {
  return planKeys(manifest, states, rates, day, windowKeys(day));
}

/**
 * What to deploy for a worker with `rates` and nothing else: every rate
 * there is to `day`, in any order. Its chunks are the ones `plan` would have
 * come to, given the rates a day at a time. A currency's place among the
 * others is by the first day it has a rate, then by its code.
 */
export function planAll(rates: Rate[], day: number) {
  const inOrder = rates.toSorted((a, b) => a.day - b.day || (a.quote < b.quote ? -1 : 1));
  const keys = [...new Set(inOrder.map((rate) => position(rate.day).key))];
  return planKeys({ currencies: [], assets: {} }, new Map(), inOrder, day, keys);
}
