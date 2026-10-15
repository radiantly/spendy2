import type { ZxcvbnResult } from "@zxcvbn-ts/core";

/** A valid base64url OPAQUE export key (bytes 0x00..0x3f). */
export const EXPORT_KEY =
  "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-Pw";

export const TOKEN = "YWxpY2U6MDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAw";

/**
 * Only the fields PasswordStrengthMeter reads; the rest of a zxcvbn result is
 * irrelevant to it, hence the cast.
 */
export function strengthResult(
  score: ZxcvbnResult["score"],
  feedback: Partial<ZxcvbnResult["feedback"]> = {},
): ZxcvbnResult {
  return {
    score,
    feedback: { warning: null, suggestions: [], ...feedback },
  } as ZxcvbnResult;
}

/** A valid transaction id (a lowercase UUIDv4) that reads as test row `n`. */
export const transactionId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A source's hash: 32 bytes, as SHA-256 gives. */
export const SOURCE_HASH = new Uint8Array(32);

/** `SOURCE_HASH` as an SQL literal. */
export const SOURCE_HASH_SQL = `X'${"00".repeat(32)}'`;
