import type { webcrypto } from "crypto";

/**
 * The scripts import browser code from src/ (e.g. src/db/parts.ts), which
 * names the `CryptoKey` type. Node has the global at runtime, and @types/node
 * declares its value but not the type the DOM lib provides.
 */
declare global {
  type CryptoKey = webcrypto.CryptoKey;
}
