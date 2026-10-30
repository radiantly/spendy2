/** Files the test page downloads, as the browser saves them. */

import { commands } from "vitest/browser";

declare module "vitest/browser" {
  interface BrowserCommands {
    nextDownload: () => Promise<{ name: string; bytes: number[] }>;
  }
}

/**
 * The next file the test page downloads: its name, and what's in it. Call
 * it before whatever downloads the file, and await it after.
 */
export async function nextDownload() {
  const { name, bytes } = await commands.nextDownload();
  return { name, bytes: new Uint8Array(bytes) };
}
