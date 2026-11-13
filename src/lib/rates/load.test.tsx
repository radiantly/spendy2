import type { ReactNode } from "react";
import {
  focusManager,
  onlineManager,
  QueryClientProvider,
  type QueryClient,
} from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderHook } from "vitest-browser-react";
import { createQueryClient } from "../../db/queryClient.ts";
import { chunkOf, serveRates, type RatesAnswer } from "../../test/rates.ts";
import {
  fetchChunk,
  loadedRates,
  RATES_ORIGIN,
  ratesQuery,
  useRates,
  useRatesProgress,
} from "./load.ts";
import { rateOf, type ChunkRef } from "./rates.ts";

/** The first day of key 5: 2026-01-27. */
const KEY_5 = 5 * 4096;

const NONE = NaN;
const USD = chunkOf(1.15, 1.16);
const GBP = chunkOf(0.87, NONE, 0.88);

type Answer = RatesAnswer | Promise<RatesAnswer>;

/** The origin's answers, by path without its slash: `{ "USD-5": chunk }`. The rest are 404s. */
function serve(answers: Record<string, Answer>) {
  return serveRates((path) => answers[path.slice(1)]);
}

/** An answer that only comes once it's let go. */
function held(answer: RatesAnswer) {
  let release!: () => void;
  const answered = new Promise<RatesAnswer>((resolve) => (release = () => resolve(answer)));
  return { answered, release };
}

/** `"USD-5"` as the chunk it names. */
function refs(...names: string[]): ChunkRef[] {
  return names.map((name) => {
    const [currency, key] = name.split("-");
    return { currency: currency!, key: Number(key) };
  });
}

let queryClient: QueryClient;

beforeEach(() => {
  queryClient = createQueryClient();
});

afterEach(() => {
  queryClient.clear();
  onlineManager.setOnline(true);
  focusManager.setFocused(undefined);
});

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function renderRates(...names: string[]) {
  return renderHook((props?: ChunkRef[]) => useRates(props ?? refs(...names)), { wrapper });
}

/** What became of loading a chunk's rates. */
const statusOf = (name: string) => {
  const [{ currency, key }] = refs(name) as [ChunkRef];
  return queryClient.getQueryState(ratesQuery(currency, key).queryKey)?.status;
};

/** The chunks the hook has rates of, as `"USD-5"`, with each one's rates. */
function loadedOf(rates: ReturnType<typeof useRates>) {
  return Object.fromEntries(
    [...rates].flatMap(([currency, chunks]) =>
      [...chunks].map(([key, filled]) => [`${currency}-${key}`, [...filled]]),
    ),
  );
}

describe("fetchChunk", () => {
  it("asks the rates' origin for the currency's chunk of the key", async () => {
    const asked = serve({ "USD-5": USD });

    const chunk = await fetchChunk("USD", 5);

    expect(asked).toEqual(["/USD-5"]);
    expect(new Uint8Array(chunk!)).toEqual(new Uint8Array(USD));
    expect(RATES_ORIGIN).toBe("https://currency.spendy2.com");
  });

  it("gives null for a chunk there isn't", async () => {
    serveRates(() => 404);

    expect(await fetchChunk("XTS", 5)).toBeNull();
  });

  it.for([500, 503, 403, 429])("fails when the origin answers %d", async (status) => {
    serveRates(() => status);

    await expect(fetchChunk("USD", 5)).rejects.toThrow(String(status));
  });

  it("fails when the request never gets there", async () => {
    serveRates(() => new TypeError("Failed to fetch"));

    await expect(fetchChunk("USD", 5)).rejects.toThrow("Failed to fetch");
  });

  it("fails without the origin, as every test does that doesn't serve rates", async () => {
    await expect(fetchChunk("USD", 5)).rejects.toThrow("Failed to fetch");
  });

  it("gives an empty chunk as it is", async () => {
    serveRates(() => new ArrayBuffer(0));

    expect((await fetchChunk("USD", 5))?.byteLength).toBe(0);
  });
});

describe("useRates", () => {
  it("has no rates until they're loaded, then each chunk's, filled", async () => {
    const usd = held(USD);
    serve({ "USD-5": usd.answered, "GBP-5": GBP });

    const { result } = await renderRates("USD-5", "GBP-5");

    await expect.poll(() => loadedOf(result.current)).toEqual({ "GBP-5": [0.87, 0.87, 0.88] });
    usd.release();
    await expect
      .poll(() => loadedOf(result.current))
      .toEqual({ "USD-5": [1.15, 1.16], "GBP-5": [0.87, 0.87, 0.88] });
    expect(rateOf(result.current, "GBP", KEY_5 + 1)).toBe(0.87);
    expect(rateOf(result.current, "USD", KEY_5 + 200)).toBe(1.16);
  });

  it("asks for each chunk once, and for no other when it starts with a rate", async () => {
    const asked = serve({ "USD-5": USD, "USD-4": USD, "GBP-5": GBP });

    const { result, rerender } = await renderRates("USD-5", "GBP-5", "USD-4");
    await expect.poll(() => Object.keys(loadedOf(result.current))).toHaveLength(3);
    await rerender(refs("GBP-5", "USD-5"));
    await rerender(refs("USD-5"));

    expect(asked.toSorted()).toEqual(["/GBP-5", "/USD-4", "/USD-5"]);
  });

  it("asks for nothing for the euro, whose rate needs no chunk", async () => {
    const asked = serve({ "USD-5": USD });

    const { result } = await renderRates("EUR-5", "USD-5");

    await expect.poll(() => loadedOf(result.current)).toEqual({ "USD-5": [1.15, 1.16] });
    expect(asked).toEqual(["/USD-5"]);
    expect(rateOf(result.current, "EUR", KEY_5)).toBe(1);
  });

  it("asks for nothing for a key before the first with rates", async () => {
    const asked = serve({ "USD-2": USD });

    const { result } = await renderRates("USD-1", "USD-0", "USD--3", "USD-2");

    await expect.poll(() => loadedOf(result.current)).toEqual({ "USD-2": [1.15, 1.16] });
    expect(asked).toEqual(["/USD-2"]);
  });

  describe("a chunk that starts without a rate", () => {
    it("has the last rate of the chunk before it for its first days", async () => {
      const asked = serve({
        "USD-5": chunkOf(NONE, NONE, 1.17),
        "USD-4": chunkOf(1.1, 1.11, NONE),
      });

      const { result } = await renderRates("USD-5");

      await expect.poll(() => loadedOf(result.current)).toEqual({ "USD-5": [1.11, 1.11, 1.17] });
      expect(asked).toEqual(["/USD-5", "/USD-4"]);
      expect(rateOf(result.current, "USD", KEY_5)).toBe(1.11);
      // The chunk before was only read for its last rate: its own days have none here.
      expect(rateOf(result.current, "USD", KEY_5 - 1)).toBeUndefined();
    });

    it("goes back past chunks without a rate, and ones there aren't", async () => {
      const asked = serve({ "USD-5": chunkOf(NONE, 1.17), "USD-4": chunkOf(NONE), "USD-2": USD });

      const { result } = await renderRates("USD-5");

      await expect.poll(() => loadedOf(result.current)).toEqual({ "USD-5": [1.16, 1.17] });
      expect(asked).toEqual(["/USD-5", "/USD-4", "/USD-3", "/USD-2"]);
    });

    it("leaves its first days without a rate when no chunk before has one", async () => {
      const asked = serve({ "USD-3": chunkOf(NONE, 1.17) });

      const { result } = await renderRates("USD-3");

      await expect.poll(() => statusOf("USD-3")).toBe("success");
      expect(asked).toEqual(["/USD-3", "/USD-2"]);
      expect(rateOf(result.current, "USD", 3 * 4096)).toBeUndefined();
      expect(rateOf(result.current, "USD", 3 * 4096 + 1)).toBe(1.17);
    });

    it("asks for no chunk before the first key's", async () => {
      const asked = serve({ "USD-2": chunkOf(NONE, 1.17) });

      const { result } = await renderRates("USD-2");

      await expect.poll(() => statusOf("USD-2")).toBe("success");
      expect(asked).toEqual(["/USD-2"]);
      expect(rateOf(result.current, "USD", 2 * 4096 + 5)).toBe(1.17);
    });

    it("asks once for a chunk that is both wanted and the one before another", async () => {
      const asked = serve({ "USD-5": chunkOf(NONE, 1.17), "USD-4": USD });

      const { result } = await renderRates("USD-5", "USD-4");

      await expect
        .poll(() => loadedOf(result.current))
        .toEqual({ "USD-5": [1.16, 1.17], "USD-4": [1.15, 1.16] });
      expect(asked.toSorted()).toEqual(["/USD-4", "/USD-5"]);
    });

    it("has no rates when the chunk before it fails", async () => {
      serve({ "USD-5": chunkOf(NONE, 1.17), "USD-4": 500 });

      const { result } = await renderRates("USD-5");

      await expect.poll(() => statusOf("USD-5")).toBe("error");
      expect(result.current.size).toBe(0);
    });
  });

  describe("a chunk there isn't", () => {
    it("has the currency's last rate for all its days, as after a currency's last", async () => {
      // No longer published: its last chunk is of key 3.
      const asked = serve({ "OLD-3": chunkOf(41, 42, NONE) });

      const { result } = await renderRates("OLD-5");

      await expect.poll(() => loadedOf(result.current)).toEqual({ "OLD-5": [42] });
      expect(asked).toEqual(["/OLD-5", "/OLD-4", "/OLD-3"]);
      expect(rateOf(result.current, "OLD", KEY_5)).toBe(42);
      expect(rateOf(result.current, "OLD", KEY_5 + 4095)).toBe(42);
    });

    it("has the last rate there is for a day in a key yet to come", async () => {
      serve({ "USD-5": USD });

      const { result } = await renderRates("USD-6");

      await expect.poll(() => loadedOf(result.current)).toEqual({ "USD-6": [1.16] });
      expect(rateOf(result.current, "USD", 6 * 4096 + 100)).toBe(1.16);
    });

    it("has no rate for a currency without any chunk", async () => {
      const asked = serve({ "USD-5": USD });

      const { result } = await renderRates("XTS-5", "USD-5");

      await expect.poll(() => statusOf("XTS-5")).toBe("success");
      expect(asked.toSorted()).toEqual(["/USD-5", "/XTS-2", "/XTS-3", "/XTS-4", "/XTS-5"]);
      expect(rateOf(result.current, "XTS", KEY_5)).toBeUndefined();
      expect(rateOf(result.current, "USD", KEY_5)).toBe(1.15);
    });
  });

  it("has no rates for a chunk that failed, and the others'", async () => {
    serve({ "USD-5": 500, "GBP-5": GBP, "INR-5": new TypeError("Failed to fetch") });

    const { result } = await renderRates("USD-5", "GBP-5", "INR-5");

    await expect.poll(() => statusOf("USD-5")).toBe("error");
    await expect.poll(() => statusOf("INR-5")).toBe("error");
    await expect.poll(() => loadedOf(result.current)).toEqual({ "GBP-5": [0.87, 0.87, 0.88] });
  });

  it("has no rates at all without the origin, and doesn't throw", async () => {
    const { result } = await renderRates("USD-5", "GBP-5");

    await expect.poll(() => statusOf("GBP-5")).toBe("error");
    await expect.poll(() => statusOf("USD-5")).toBe("error");
    expect(result.current.size).toBe(0);
  });

  it("has none for no chunks", async () => {
    const asked = serve({ "USD-5": USD });

    const { result } = await renderRates();

    expect(result.current.size).toBe(0);
    expect(asked).toEqual([]);
  });

  it("loads the rates of a chunk that comes later, keeping the others'", async () => {
    const asked = serve({ "USD-5": USD, "GBP-5": GBP });
    const { result, rerender } = await renderRates("USD-5");
    await expect.poll(() => loadedOf(result.current)).toEqual({ "USD-5": [1.15, 1.16] });
    const before = result.current.get("USD")!.get(5);

    await rerender(refs("USD-5", "GBP-5"));

    await expect.poll(() => Object.keys(loadedOf(result.current))).toHaveLength(2);
    expect(asked).toEqual(["/USD-5", "/GBP-5"]);
    expect(result.current.get("USD")!.get(5)).toBe(before);
  });

  it("tries a chunk that failed again when the window is next focused", async () => {
    let answer: RatesAnswer = 503;
    const asked = serveRates(() => answer);
    const { result } = await renderRates("USD-5");
    await expect.poll(() => statusOf("USD-5")).toBe("error");

    answer = USD;
    focusManager.setFocused(false);
    focusManager.setFocused(true);

    await expect.poll(() => loadedOf(result.current)).toEqual({ "USD-5": [1.15, 1.16] });
    expect(asked).toEqual(["/USD-5", "/USD-5"]);
  });

  it("doesn't ask again for the chunks it has when the window is focused", async () => {
    const asked = serve({ "USD-5": USD });
    const { result } = await renderRates("USD-5", "XTS-5");
    await expect.poll(() => loadedOf(result.current)).toHaveProperty("USD-5");
    await expect.poll(() => statusOf("XTS-5")).toBe("success");
    const before = asked.length;

    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(asked).toHaveLength(before);
  });

  it("waits for the network offline, rather than failing", async () => {
    onlineManager.setOnline(false);
    const asked = serve({ "USD-5": USD });

    const { result } = await renderRates("USD-5");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked).toEqual([]);
    expect(statusOf("USD-5")).toBe("pending");
    expect(result.current.size).toBe(0);

    onlineManager.setOnline(true);

    await expect.poll(() => loadedOf(result.current)).toEqual({ "USD-5": [1.15, 1.16] });
  });
});

describe("loadedRates", () => {
  it("has the rates that are loaded, without asking for any", async () => {
    const asked = serve({ "USD-5": USD, "GBP-5": GBP });
    const { result } = await renderRates("USD-5");
    await expect.poll(() => loadedOf(result.current)).toHaveProperty("USD-5");

    const rates = loadedRates(queryClient, refs("USD-5", "GBP-5", "EUR-5", "USD-1"));

    expect(loadedOf(rates)).toEqual({ "USD-5": [1.15, 1.16] });
    expect(rateOf(rates, "EUR", KEY_5)).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked).toEqual(["/USD-5"]);
    expect(statusOf("GBP-5")).toBeUndefined();
  });

  it("has none before any is loaded, or of one that failed", async () => {
    serve({ "USD-5": 500 });
    expect(loadedRates(queryClient, refs("USD-5")).size).toBe(0);
    await renderRates("USD-5");
    await expect.poll(() => statusOf("USD-5")).toBe("error");

    expect(loadedRates(queryClient, refs("USD-5")).size).toBe(0);
  });
});

describe("useRatesProgress", () => {
  function renderProgress(...names: string[]) {
    return renderHook((props?: ChunkRef[]) => useRatesProgress(props ?? refs(...names)), {
      wrapper,
    });
  }

  it("is null while a chunk is on its way, then names the ones loaded", async () => {
    const usd = held(USD);
    serve({ "USD-5": usd.answered, "GBP-5": GBP });

    const { result } = await renderProgress("USD-5", "GBP-5");

    await expect.poll(() => statusOf("GBP-5")).toBe("success");
    // The pound's are loaded, but the dollar's aren't yet: not half the story.
    expect(result.current).toBeNull();
    usd.release();
    await expect.poll(() => result.current).toBe("GBP-5 USD-5");
    expect(loadedOf(loadedRates(queryClient, refs("USD-5", "GBP-5")))).toEqual({
      "USD-5": [1.15, 1.16],
      "GBP-5": [0.87, 0.87, 0.88],
    });
  });

  it("names only the ones that loaded once the rest have failed", async () => {
    serve({ "USD-5": 500, "GBP-5": GBP });

    const { result } = await renderProgress("USD-5", "GBP-5");

    await expect.poll(() => result.current).toBe("GBP-5");
  });

  it("is empty when none loaded, and for no chunks", async () => {
    const { result } = await renderProgress("USD-5");
    await expect.poll(() => statusOf("USD-5")).toBe("error");
    expect(result.current).toBe("");

    const none = await renderProgress();
    expect(none.result.current).toBe("");
  });

  it("is the same for the same chunks loaded, whatever order they're asked in", async () => {
    serve({ "USD-5": USD, "GBP-5": GBP });
    const { result, rerender } = await renderProgress("USD-5", "GBP-5");
    await expect.poll(() => result.current).toBe("GBP-5 USD-5");

    await rerender(refs("GBP-5", "USD-5"));

    expect(result.current).toBe("GBP-5 USD-5");
  });

  it("leaves out the euro and the keys before the first, which have nothing to load", async () => {
    serve({ "USD-5": USD });

    const { result } = await renderProgress("EUR-5", "USD-1", "USD-5");

    await expect.poll(() => result.current).toBe("USD-5");
  });

  it("is empty offline, where nothing is on its way", async () => {
    onlineManager.setOnline(false);
    serve({ "USD-5": USD });

    const { result } = await renderProgress("USD-5");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(result.current).toBe("");

    onlineManager.setOnline(true);
    await expect.poll(() => result.current).toBe("USD-5");
  });

  it("names a chunk that failed once it loads, when the window is next focused", async () => {
    let answer: RatesAnswer = 503;
    serveRates(() => answer);
    const { result } = await renderProgress("USD-5");
    await expect.poll(() => statusOf("USD-5")).toBe("error");
    expect(result.current).toBe("");

    answer = USD;
    focusManager.setFocused(false);
    focusManager.setFocused(true);

    await expect.poll(() => result.current).toBe("USD-5");
  });
});
