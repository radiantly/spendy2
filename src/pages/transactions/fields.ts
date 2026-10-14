/**
 * Formatting and parsing for the editable transaction fields. Each `parse*`
 * turns what the user typed into the value stored in SQL, or an error to
 * show on the cell.
 */

import { currencyDecimals, formattable } from "../../lib/money.ts";
import { reduce, type Rational } from "../../lib/rational.ts";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
const fail = (error: string): ParseResult<never> => ({ ok: false, error });

/** The parsed value passed through `map`, or the same error. */
export function mapResult<T, U>(result: ParseResult<T>, map: (value: T) => U): ParseResult<U> {
  return result.ok ? ok(map(result.value)) : result;
}

/** With the currency's usual decimals, rounded half away from zero. */
function formatDecimals(amount: Rational, currency: string, grouping: boolean) {
  const decimals = currencyDecimals(currency);
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: grouping,
  }).format(formattable(amount, decimals));
}

/** The number part of `formatAmount`: `1,234.50`. */
export function formatAmountValue(amount: Rational, currency: string) {
  return formatDecimals(amount, currency, true);
}

/** For display: `USD 1,234.50`, with the currency's usual decimals. */
export function formatAmount(amount: Rational, currency: string) {
  return `${currency} ${formatAmountValue(amount, currency)}`;
}

/**
 * For editing: just the number, without the currency or grouping
 * (`1234.50`). Like the display, it has the currency's usual decimals, so an
 * amount with more (like a third) is rounded if it's edited.
 */
export function amountEditText(amount: Rational, currency: string) {
  return formatDecimals(amount, currency, false);
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** Parses `-1,234.5` exactly, as the fraction -2469/2. */
export function parseAmount(text: string): ParseResult<Rational> {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text.replaceAll(",", "").trim());
  if (!match || (match[2] === "" && !match[3])) return fail("Enter a number, like -12.50");

  const [, sign, whole, typed = ""] = match;
  // Trailing zeros don't change the amount, but would make its denominator larger.
  const fraction = typed.replace(/0+$/, "");
  // BigInt, as Number would round a too-large one to a safe integer.
  const digits = BigInt(`${whole}${fraction}` || "0");
  if (digits > MAX_SAFE) return fail("That amount is too large");
  const amount = reduce(sign === "-" ? -Number(digits) : Number(digits), 10 ** fraction.length);
  return amount === null ? fail("That amount has too many decimals") : ok(amount);
}

/** A local date as `YYYY-MM-DD`, the format the schema checks with `date()`. */
export function parseNaiveDate(text: string): ParseResult<string> {
  const value = text.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return fail("Enter a date as YYYY-MM-DD");

  const [, year, month, day] = match.map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month! - 1 ||
    date.getUTCDate() !== day
  )
    return fail(`${value} isn't a valid date`);
  return ok(value);
}

export function parseCounterparty(text: string): ParseResult<string> {
  const value = text.trim();
  return value === "" ? fail("Enter a counterparty") : ok(value);
}

/** Empty clears the remarks. */
export function parseRemarks(text: string): ParseResult<string | null> {
  const value = text.trim();
  return ok(value === "" ? null : value);
}

/**
 * The name in `names` that `text` spells, ignoring case and surrounding
 * spaces, but preferring an exact match: SQLite's NOCASE only folds A-Z, so
 * names like "épicerie" and "Épicerie" can both exist.
 */
export function findName(names: readonly string[], text: string): string | undefined {
  const value = text.trim();
  const wanted = value.toLowerCase();
  return (
    names.find((name) => name === value) ?? names.find((name) => name.toLowerCase() === wanted)
  );
}

/**
 * Empty clears the category. Otherwise it must name one of `categories`
 * (ignoring case), or, with `create`, a new category is accepted as typed.
 */
export function parseCategory(
  text: string,
  categories: readonly string[],
  create = false,
): ParseResult<string | null> {
  const value = text.trim();
  if (value === "") return ok(null);
  const existing = findName(categories, value);
  if (existing !== undefined) return ok(existing);
  return create ? ok(value) : fail(`There's no category named “${value}”`);
}

/** Must name one of `accounts`, ignoring case. */
export function parseAccount(text: string, accounts: readonly string[]): ParseResult<string> {
  const value = text.trim();
  if (value === "") return fail("Choose an account");
  const existing = findName(accounts, value);
  return existing !== undefined ? ok(existing) : fail(`There's no account named “${value}”`);
}
