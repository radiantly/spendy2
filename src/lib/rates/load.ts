/**
 * Loads exchange rates from `currency.spendy2.com`, a chunk a request (the
 * format is in `workers/currency/chunks.ts`), through TanStack Query.
 *
 * The rates are a fallback, and so is doing without them: a chunk that can't
 * be fetched is one without rates, and nothing waits for one. A chunk is
 * fetched once in a session. One that failed is tried again when the window
 * is next focused or the network comes back, while something is using it.
 */
import {
  queryOptions,
  useQueries,
  type QueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { FIRST_DAY, chunkPath, position } from "../../../workers/currency/chunks.ts";
import { EURO, type ChunkRef, type Rates } from "./rates.ts";
import { fill, lastRate, startsWithout } from "./reader.ts";

/** Where the rates are published. It is public, and only ever read. */
export const RATES_ORIGIN = "https://currency.spendy2.com";

/** The first key there are chunks of. */
const FIRST_KEY = position(FIRST_DAY).key;

/** A currency's chunk of a key as it is served, or null when it has none. */
export async function fetchChunk(currency: string, key: number, signal?: AbortSignal) {
  const response = await fetch(RATES_ORIGIN + chunkPath(currency, key), { signal });
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error(`The rates of ${currency} (chunk ${key}) answered ${response.status}`);
  return response.arrayBuffer();
}

/** A currency's chunk of a key, as it is served: null when it has none. */
export function chunkQuery(currency: string, key: number) {
  return queryOptions({
    // Not under a database's key: the rates are the same for every one.
    queryKey: ["rates", "served", currency, key],
    queryFn: ({ signal }) => fetchChunk(currency, key, signal),
    // Unlike the database's queries (see createQueryClient), it needs the
    // network: offline, it waits for it rather than failing.
    networkMode: "online",
  });
}

/**
 * The rate of a currency in force as its chunk of a key starts: the last of
 * the nearest chunk before it with one, NaN when none has.
 */
async function rateBefore(client: QueryClient, currency: string, key: number) {
  for (let earlier = key - 1; earlier >= FIRST_KEY; earlier--) {
    const chunk = await client.ensureQueryData(chunkQuery(currency, earlier));
    const rate = chunk === null ? NaN : lastRate(chunk);
    if (!Number.isNaN(rate)) return rate;
  }
  return NaN;
}

/**
 * A currency's rates of a key's days, filled (see `fill`). The chunks before
 * it are only fetched when its first days have no rate of their own: when it
 * starts without one, or isn't there at all, as after a currency's last.
 */
export function ratesQuery(currency: string, key: number) {
  return queryOptions({
    queryKey: ["rates", "filled", currency, key],
    queryFn: async ({ client }) => {
      const chunk = await client.ensureQueryData(chunkQuery(currency, key));
      const carried = chunk === null || startsWithout(chunk);
      return fill(chunk, carried ? await rateBefore(client, currency, key) : NaN);
    },
    networkMode: "online",
    // A filled chunk is only ever replaced whole.
    structuralSharing: false,
  });
}

/** The chunks with rates to load: the euro has none, and nothing has before the first key. */
function loadable(chunks: readonly ChunkRef[]) {
  return chunks.filter(({ currency, key }) => currency !== EURO && key >= FIRST_KEY);
}

/** The rates of `chunks` (all loadable), each with its filled chunk at the same index, if any. */
function ratesOf(
  chunks: readonly ChunkRef[],
  filled: readonly (Float64Array | null | undefined)[],
) {
  const rates = new Map<string, Map<number, Float64Array>>();
  for (const [index, { currency, key }] of chunks.entries()) {
    const chunk = filled[index];
    if (!chunk) continue;
    const ofCurrency = rates.get(currency) ?? new Map<number, Float64Array>();
    rates.set(currency, ofCurrency.set(key, chunk));
  }
  return rates;
}

/** Each query's rates, null until it has them. An array of them only changes when one does. */
function loaded(results: UseQueryResult<Float64Array>[]) {
  return results.map((result) => result.data ?? null);
}

/**
 * The rates of `chunks`, those that are loaded, loading the rest. Like any
 * query's, the loading starts once what uses it is on screen: a hidden page's
 * rates wait until it is shown.
 */
export function useRates(chunks: readonly ChunkRef[]): Rates {
  const wanted = loadable(chunks);
  const filled = useQueries({
    queries: wanted.map(({ currency, key }) => ratesQuery(currency, key)),
    combine: loaded,
  });
  return ratesOf(wanted, filled);
}

/**
 * The rates of `chunks` that are loaded already, without loading any or
 * waiting for one: for what must not wait for rates, and makes do.
 */
export function loadedRates(client: QueryClient, chunks: readonly ChunkRef[]): Rates {
  const wanted = loadable(chunks);
  return ratesOf(
    wanted,
    wanted.map(({ currency, key }) => client.getQueryData(ratesQuery(currency, key).queryKey)),
  );
}

/** Which rates are loaded, or null while one is on its way. A string, to be the same while they are. */
function progress(results: UseQueryResult<Float64Array>[]) {
  if (results.some((result) => result.fetchStatus === "fetching")) return null;
  return results.map((result) => (result.data === undefined ? "0" : "1")).join("");
}

/**
 * Loads the rates of `chunks` for `loadedRates` to find, and says how far
 * that has got: null while any is on its way, and once none is, which of them
 * are loaded, as a text that is different whenever they are. So what read
 * the rates before they were loaded can read them again once, when they all
 * are, rather than as each arrives.
 */
export function useRatesProgress(chunks: readonly ChunkRef[]): string | null {
  const wanted = loadable(chunks);
  const flags = useQueries({
    queries: wanted.map(({ currency, key }) => ratesQuery(currency, key)),
    combine: progress,
  });
  if (flags === null) return null;
  return wanted
    .filter((_, index) => flags[index] === "1")
    .map(({ currency, key }) => `${currency}-${key}`)
    .sort()
    .join(" ");
}
