import type { Score, ZxcvbnResult } from "@zxcvbn-ts/core";

const SCORES: Score[] = [0, 1, 2, 3, 4];

/** `summary` is shown in place of the label when zxcvbn has no advice. */
const LEVELS: Record<Score, { label: string; summary: string; color: string }> = {
  0: {
    label: "Very weak",
    summary: "This password is very weak.",
    color: "bg-strength-0",
  },
  1: {
    label: "Weak",
    summary: "This password is weak.",
    color: "bg-strength-1",
  },
  2: {
    label: "Fair",
    summary: "This password is fair.",
    color: "bg-strength-2",
  },
  3: {
    label: "Good",
    summary: "That's a decent password.",
    color: "bg-strength-3",
  },
  4: {
    label: "Strong",
    summary: "That's a strong password!",
    color: "bg-strength-4",
  },
};

type PasswordStrengthMeterProps = {
  /** null renders an empty meter (no password yet, or still loading). */
  result: ZxcvbnResult | null;
  /** Highlights the placeholder text, e.g. when a password is required. */
  invalid?: boolean;
};

/**
 * One bar per zxcvbn score. The text below is always a single line so the
 * layout doesn't shift while typing; long advice is truncated with the full
 * text available on hover.
 */
function PasswordStrengthMeter({ result, invalid = false }: PasswordStrengthMeterProps) {
  const level = result ? LEVELS[result.score] : null;
  const filledBars = result ? result.score + 1 : 0;
  const advice = result?.feedback.warning ?? result?.feedback.suggestions[0];

  return (
    <div className="mt-1.5 flex flex-col gap-2">
      <div className="flex gap-1.5" aria-hidden>
        {SCORES.map((score) => (
          <span
            key={score}
            className={`h-1.5 flex-1 rounded-full transition-colors ${
              level && score < filledBars ? level.color : "bg-line"
            }`}
          />
        ))}
      </div>
      <p className="flex min-w-0 gap-1 whitespace-nowrap" aria-live="polite">
        {level && advice ? (
          <>
            <span className="shrink-0 font-medium text-ink">{level.label}</span>
            <span className="truncate" title={advice}>
              · {advice}
            </span>
          </>
        ) : level ? (
          <span className="truncate font-medium text-ink">{level.summary}</span>
        ) : (
          <span className={`truncate ${invalid ? "text-danger" : ""}`}>
            Use a long passphrase that's hard to guess.
          </span>
        )}
      </p>
    </div>
  );
}

export default PasswordStrengthMeter;
