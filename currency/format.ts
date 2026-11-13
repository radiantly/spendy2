/**
 * What publishing the exchange rates takes beyond `chunks.ts`, which says
 * what a chunk is (see CURRENCY_PLAN.md).
 *
 * `/KEY` is the state of a key: every currency's chunk of that key, one after
 * the other in the manifest's order, so that whatever adds a day's rates
 * reads them all in one request. Only the keys still being written to have
 * one. `/manifest.json` says how to take it apart.
 */
import { RATE_BYTES, chunkPath, position } from "./chunks.ts";

export const MANIFEST_PATH = "/manifest.json";

/** An asset as an upload names it: by its `contentHash`, with how many bytes it is. */
export type AssetEntry = { hash: string; size: number };

export type Manifest = {
  /**
   * Every currency with a chunk, in the order a state has them. Only ever
   * added to at its end.
   */
  currencies: string[];
  /** Every asset but the manifest itself, by its path. */
  assets: Record<string, AssetEntry>;
};

/** A currency's rate on a day: `rate` of `quote` to one euro. */
export type Rate = { day: number; quote: string; rate: number };

/** No chunk's path is one: a chunk's has its currency before the key. */
export function statePath(key: number) {
  return `/${key}`;
}

/** The key a state's path is of, or undefined for any other path. */
export function stateKey(path: string) {
  return /^\/-?\d+$/.test(path) ? Number(path.slice(1)) : undefined;
}

export type Patched = {
  /** The manifest's currencies, then any the rates added. */
  currencies: string[];
  /** The key's new state. */
  state: Uint8Array<ArrayBuffer>;
  /** Each currency's chunk within `state`, in their order; empty for one without any. */
  chunks: Uint8Array<ArrayBuffer>[];
};

/**
 * The state of `key` with `rates` written into it: each over what was there
 * for its day, or past its chunk's end, with NaN for the days in between.
 * Nothing is ever taken out of a chunk. `state` is the one `manifest`
 * describes, or nothing when the key has no chunks yet. Rates for the days of
 * another key are left out.
 */
export function patchState(
  manifest: Manifest,
  state: Uint8Array | undefined,
  key: number,
  rates: Rate[],
): Patched {
  const old = state ?? new Uint8Array(0);
  const currencies = [...manifest.currencies];
  const indexOf = new Map(currencies.map((currency, index) => [currency, index]));
  const oldSizes = currencies.map(
    (currency) => manifest.assets[chunkPath(currency, key)]?.size ?? 0,
  );
  const oldTotal = oldSizes.reduce((total, size) => total + size, 0);
  if (oldTotal !== old.length)
    throw new Error(
      `${statePath(key)} is ${old.length} bytes, and the manifest's chunks ${oldTotal}`,
    );

  const writes: { currency: number; index: number; rate: number }[] = [];
  const sizes = [...oldSizes];
  for (const { day, quote, rate } of rates) {
    const at = position(day);
    if (at.key !== key) continue;
    let currency = indexOf.get(quote);
    if (currency === undefined) {
      currency = currencies.push(quote) - 1;
      indexOf.set(quote, currency);
      oldSizes.push(0);
      sizes.push(0);
    }
    writes.push({ currency, index: at.index, rate });
    sizes[currency] = Math.max(sizes[currency]!, (at.index + 1) * RATE_BYTES);
  }

  const patched = new Uint8Array(sizes.reduce((total, size) => total + size, 0));
  const view = new DataView(patched.buffer);
  const starts: number[] = [];
  let from = 0;
  let to = 0;
  for (const [currency, size] of sizes.entries()) {
    const oldSize = oldSizes[currency]!;
    starts.push(to);
    patched.set(old.subarray(from, from + oldSize), to);
    // The days past the old end without a rate, until one is written below.
    for (let at = oldSize; at < size; at += RATE_BYTES) view.setFloat64(to + at, NaN, true);
    from += oldSize;
    to += size;
  }
  for (const { currency, index, rate } of writes)
    view.setFloat64(starts[currency]! + index * RATE_BYTES, rate, true);

  return {
    currencies,
    state: patched,
    chunks: sizes.map((size, currency) =>
      patched.subarray(starts[currency]!, starts[currency]! + size),
    ),
  };
}

/**
 * The hash an upload names an asset by: the first 32 hex digits of its
 * SHA-256. Cloudflare uploads a file only when it has none by its hash, and
 * serves the hash as the file's ETag: a file that hasn't changed is neither
 * uploaded nor downloaded again.
 */
export async function contentHash(bytes: Uint8Array<ArrayBuffer>) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return digest.subarray(0, 16).toHex();
}

/** A text's bytes, in UTF-8. */
export function utf8(text: string) {
  // Always over an ArrayBuffer of its own, which the workers' types don't say.
  return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
}

/** A manifest as `/manifest.json` has it. */
export function manifestBytes(manifest: Manifest) {
  return utf8(JSON.stringify(manifest));
}
