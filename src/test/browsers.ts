import { it } from "vitest";
import { server } from "vitest/browser";

/**
 * `it`, but expected to fail in Firefox: for what it doesn't do (yet).
 * Once a Firefox does, the test fails there, so the marker can go.
 */
export const itFailsInFirefox = server.browser === "firefox" ? it.fails : it;
