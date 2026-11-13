import { vi } from "vitest";
import { RATES_ORIGIN } from "../lib/rates/load.ts";

// The real one, from before anything here stands in for it.
const realFetch = globalThis.fetch.bind(globalThis);

/** A chunk as it is served: these rates, a day each from its first. NaN is a day without one. */
export function chunkOf(...rates: number[]) {
  const view = new DataView(new ArrayBuffer(rates.length * 8));
  for (const [index, rate] of rates.entries()) view.setFloat64(index * 8, rate, true);
  return view.buffer;
}

/**
 * What the rates' origin answers a path, such as `/USD-5`, with: a chunk, a
 * status other than 200, or an error for a request that never got there.
 */
export type RatesAnswer = ArrayBuffer | number | Error;

/**
 * Has the rates' origin answer as `answer` says, for the rest of the test,
 * rather than not at all (see `withoutRates`). A path it has no answer for
 * is a 404, as the origin's own are. Gives the paths asked for, in order.
 */
export function serveRates(
  answer: (path: string) => RatesAnswer | undefined | Promise<RatesAnswer | undefined>,
) {
  const asked: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input, location.href);
    if (url.origin !== RATES_ORIGIN) return realFetch(input, init);
    asked.push(url.pathname);
    const answered = (await answer(url.pathname)) ?? 404;
    init?.signal?.throwIfAborted();
    if (answered instanceof Error) throw answered;
    if (typeof answered === "number") return new Response(null, { status: answered });
    return new Response(answered);
  });
  return asked;
}

/**
 * Cuts the rates' origin off: every request to it fails, as offline. No test
 * may reach the real one, so the setup does this before each.
 */
export function withoutRates() {
  return serveRates(() => new TypeError("Failed to fetch"));
}
