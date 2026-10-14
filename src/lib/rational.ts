/**
 * Exact fractions, as the schema stores amounts: a numerator and a positive
 * denominator, both safe integers.
 */

export type Rational = { numerator: number; denominator: number };

function gcd(a: number, b: number) {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

/**
 * The fraction in lowest terms with a positive denominator, or null if
 * either part isn't a safe integer or the denominator is 0.
 */
export function reduce(numerator: number, denominator: number): Rational | null {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) return null;
  if (denominator === 0) return null;
  const divisor = gcd(Math.abs(numerator), Math.abs(denominator)) * Math.sign(denominator);
  // `|| 0` turns -0 (from a negative denominator over 0) into 0.
  return { numerator: numerator / divisor || 0, denominator: denominator / divisor };
}

/** The nearest float, for sums and comparisons where exactness doesn't matter. */
export function toNumber({ numerator, denominator }: Rational) {
  return numerator / denominator;
}

/**
 * The decimal expansion cut off (not rounded) after `digits` places,
 * `-1.333` for -4/3 to 3 places. Exact, so `Intl.NumberFormat` can round it:
 * cutting off first never changes which way a half-away-from-zero rounding
 * to fewer places goes, since what's cut off only moves the value away from
 * zero.
 */
export function toDecimalString(
  { numerator, denominator }: Rational,
  digits: number,
): Intl.StringNumericLiteral {
  // BigInt, as the remainder × 10 can pass the largest safe integer.
  const d = BigInt(denominator);
  let n = BigInt(numerator);
  const sign = n < 0n ? "-" : "";
  if (n < 0n) n = -n;

  let fraction = "";
  let remainder = n % d;
  for (let i = 0; i < digits; i++) {
    remainder *= 10n;
    fraction += String(remainder / d);
    remainder %= d;
  }
  // Digits with an optional sign and point: a numeric literal.
  return `${sign}${n / d}${fraction && `.${fraction}`}` as Intl.StringNumericLiteral;
}
