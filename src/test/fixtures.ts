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
