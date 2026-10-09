import { useEffect, useState } from "react";
import type { ZxcvbnResult } from "@zxcvbn-ts/core";
import {
  loadPasswordStrengthEstimator,
  type PasswordStrengthEstimator,
} from "../lib/passwordStrength.ts";

/**
 * Estimates password strength. Returns null while the estimator is
 * loading or when the password is empty.
 *
 * The estimator (and its dictionaries) is only downloaded once a password is
 * entered, so mounting the hook alone costs nothing.
 *
 * @param userInputs values the password should not resemble (e.g. username)
 */
export function usePasswordStrength(password: string, userInputs: string[]): ZxcvbnResult | null {
  const [estimate, setEstimate] = useState<PasswordStrengthEstimator | null>(null);
  const needed = password !== "";

  useEffect(() => {
    if (!needed || estimate) return;
    let cancelled = false;
    loadPasswordStrengthEstimator().then((estimator) => {
      if (!cancelled) setEstimate(() => estimator);
    });
    return () => {
      cancelled = true;
    };
  }, [needed, estimate]);

  if (!estimate || password === "") return null;
  return estimate(password, userInputs);
}
