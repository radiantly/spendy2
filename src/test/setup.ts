import { afterEach, vi } from "vitest";
import { locators, type Locator } from "vitest/browser";
import { clear, createStore } from "idb-keyval";
import { toast } from "sonner";
import "@fontsource/gloria-hallelujah";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "../index.css";

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
