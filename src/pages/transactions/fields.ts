/**
 * Formatting and parsing for the editable transaction fields. Each `parse*`
 * turns what the user typed into the value stored in SQL, or an error to
 * show on the cell.
 */

import { currencyDecimals, decimalString, formattable, type Amount } from "../../lib/money.ts";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
const fail = (error: string): ParseResult<never> => ({ ok: false, error });

/** The parsed value passed through `map`, or the same error. */
export function mapResult<T, U>(result: ParseResult<T>, map: (value: T) => U): ParseResult<U> {
  return result.ok ? ok(map(result.value)) : result;
}

/** The number part of `formatAmount`: `1,234.50`, with the currency's usual decimals. */
export function formatAmountValue(amount: Amount, currency: string) {
  const decimals = currencyDecimals(currency);
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(formattable(amount));
}

/** For display: `USD 1,234.50`, with the currency's usual decimals. */
export function formatAmount(amount: Amount, currency: string) {
  return `${currency} ${formatAmountValue(amount, currency)}`;
}

/**
 * For editing: just the number, without the currency or grouping
 * (`1234.50`). Exactly as stored, even with more decimals than the currency
 * is usually shown with, so editing it doesn't round it.
 */
export function amountEditText(amount: Amount) {
  return decimalString(amount);
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Parses `-1,234.5` into an amount stored with `decimals`: -123450 with 2.
 * More decimals than that are rounded, half away from zero, as the display
 * rounds.
 */
export function parseAmount(text: string, decimals: number): ParseResult<number> {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text.replaceAll(",", "").trim());
  if (!match || (match[2] === "" && !match[3])) return fail("Enter a number, like -12.50");

  const [, sign, whole, fraction = ""] = match;
  // BigInt, as Number would round a too-large one to a safe integer.
  let units = BigInt(`${whole}${fraction.slice(0, decimals).padEnd(decimals, "0")}` || "0");
  if ((fraction[decimals] ?? "0") >= "5") units++;
  if (units > MAX_SAFE) return fail("That amount is too large");
  // `|| 0` turns -0 (from rounding a small negative amount away) into 0.
  return ok(sign === "-" ? -Number(units) || 0 : Number(units));
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
