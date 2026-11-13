import { afterEach, beforeAll, beforeEach, vi } from "vitest";
import { locators, type Locator } from "vitest/browser";
import { clear, createStore } from "idb-keyval";
import { toast } from "sonner";
import "@fontsource/gloria-hallelujah";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "../index.css";
import { withoutRates } from "./rates.ts";

declare module "vitest/browser" {
  interface LocatorSelectors {
    /**
     * Only the matches on screen. The shell keeps every page rendered, the
     * hidden ones too (see AppShell), so text can be on more than one.
     */
    shown(): Locator;
  }
}

locators.extend({
  shown() {
    return "visible=true";
  },
});

// The browser loads a font once text first needs it, showing a fallback
// until then: a test measuring text could measure the fallback, and later
// text the font. So they're loaded before any test runs.
beforeAll(async () => {
  const families = [
    "Geist Variable",
    "Geist Mono Variable",
    "Bricolage Grotesque Variable",
    "Gloria Hallelujah",
  ];
  await Promise.all(
    families.map(async (family) => {
      const faces = await document.fonts.load(`1em "${family}"`);
      // Loading a font with no faces does nothing, rather than failing.
      if (faces.length === 0) throw new Error(`No font face for ${family}`);
    }),
  );
});

// The exchange rates are another origin's, which no test may reach: without
// `serveRates`, a test has none, as the app has offline. (Restored with the
// other mocks, below.)
beforeEach(() => {
  withoutRates();
});

// The store session.ts uses. Cleared directly rather than through
// session.ts, so that test files can still `vi.mock` that module.
const sessionStore = createStore("spendy", "session");

afterEach(async () => {
  vi.restoreAllMocks();
  // Toasts live in a global store, which shows the open ones to the next
  // test's Toaster.
  toast.dismiss();
  await clear(sessionStore);
});
