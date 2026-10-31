/** What the test page's user prefers, as media queries see it. */

import { onTestFinished, vi } from "vitest";
import { commands } from "vitest/browser";

type Media = {
  colorScheme?: "light" | "dark" | null;
  reducedMotion?: "reduce" | "no-preference" | null;
};

declare module "vitest/browser" {
  interface BrowserCommands {
    emulateMedia: (media: Media) => Promise<void>;
  }
}

/**
 * Has the test page's user prefer `media` until the test's finished, when
 * `media` with each feature null goes back to the browser's own. Each time,
 * it waits for `query` to see it: Firefox's page sees it a moment after
 * the command's done.
 */
async function prefer(media: Media, query: string) {
  const list = matchMedia(query);
  const before = list.matches;
  const own = Object.fromEntries(Object.keys(media).map((feature) => [feature, null]));
  onTestFinished(async () => {
    await commands.emulateMedia(own);
    await vi.waitUntil(() => list.matches === before);
  });
  await commands.emulateMedia(media);
  await vi.waitUntil(() => list.matches);
}

/** Has the test page's user prefer dark colors, until the test's finished. */
export const preferDark = () => prefer({ colorScheme: "dark" }, "(prefers-color-scheme: dark)");

/** Has the test page's user prefer reduced motion, until the test's finished. */
export const preferReducedMotion = () =>
  prefer({ reducedMotion: "reduce" }, "(prefers-reduced-motion: reduce)");
