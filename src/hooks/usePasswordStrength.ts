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
 * @param userInputs values the password should not resemble (e.g. username)
 */
export function usePasswordStrength(password: string, userInputs: string[]): ZxcvbnResult | null {
  const [estimate, setEstimate] = useState<PasswordStrengthEstimator | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadPasswordStrengthEstimator().then((estimator) => {
      if (!cancelled) setEstimate(() => estimator);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!estimate || password === "") return null;
  return estimate(password, userInputs);
}
