import { RATE_BYTES, chunkPath } from "../chunks.ts";
import { MANIFEST_PATH, contentHash, manifestBytes, statePath, type Manifest } from "../format.ts";

/** A chunk of these rates, a day each from its first. */
export function chunkOf(...rates: number[]) {
  const bytes = new Uint8Array(rates.length * RATE_BYTES);
  const view = new DataView(bytes.buffer);
  for (const [index, rate] of rates.entries()) view.setFloat64(index * RATE_BYTES, rate, true);
  return bytes;
}

/** The rates of a chunk, a day each from its first. */
export function ratesOf(chunk: Uint8Array) {
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return Array.from({ length: chunk.length / RATE_BYTES }, (_, index) =>
    view.getFloat64(index * RATE_BYTES, true),
  );
}

/** The bytes one after the other. */
export function joined(...parts: Uint8Array[]) {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

/** The currency worker's assets, by path: what it serves. */
export type Served = Map<string, Uint8Array<ArrayBuffer>>;

/**
 * The assets of a worker with these chunks, by key then currency, the
 * currencies in the order they're first come to. A key has a state when
 * `states` has it.
 */
export async function servedWith(
  chunks: Record<number, Record<string, number[]>>,
  states: number[] = Object.keys(chunks).map(Number),
) {
  const served: Served = new Map();
  const manifest: Manifest = { currencies: [], assets: {} };
  const put = async (path: string, bytes: Uint8Array<ArrayBuffer>) => {
    served.set(path, bytes);
    manifest.assets[path] = { hash: await contentHash(bytes), size: bytes.length };
  };
  for (const ofKey of Object.values(chunks))
    for (const currency of Object.keys(ofKey))
      if (!manifest.currencies.includes(currency)) manifest.currencies.push(currency);
  for (const [key, ofKey] of Object.entries(chunks)) {
    const inOrder = manifest.currencies.flatMap((currency) =>
      ofKey[currency] === undefined ? [] : [[currency, chunkOf(...ofKey[currency])] as const],
    );
    for (const [currency, bytes] of inOrder) await put(chunkPath(currency, Number(key)), bytes);
    if (states.includes(Number(key)))
      await put(statePath(Number(key)), joined(...inOrder.map(([, bytes]) => bytes)));
  }
  served.set(MANIFEST_PATH, manifestBytes(manifest));
  return { served, manifest };
}
