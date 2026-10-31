/** The color scheme the test page's user prefers, as media queries see it. */

import { onTestFinished, vi } from "vitest";
import { commands } from "vitest/browser";

declare module "vitest/browser" {
  interface BrowserCommands {
    colorScheme: (scheme: "light" | "dark" | null) => Promise<void>;
  }
}

/**
 * Has the test page's user prefer dark colors, until the test's finished.
 * Each time, it waits for the page to see it: Firefox's sees it a moment
 * after the command's done.
 */
export async function preferDark() {
  const dark = matchMedia("(prefers-color-scheme: dark)");
  const before = dark.matches;
  onTestFinished(async () => {
    await commands.colorScheme(null);
    await vi.waitUntil(() => dark.matches === before);
  });
  await commands.colorScheme("dark");
  await vi.waitUntil(() => dark.matches);
}
