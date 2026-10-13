/**
 * Formatting and parsing for the editable transaction fields. Each `parse*`
 * turns what the user typed into the value stored in SQL, or an error to
 * show on the cell.
 */

import { AMOUNT_DECIMALS, AMOUNT_SCALE } from "../../db/queries/transactions.ts";
import { currencyDecimals } from "../../lib/money.ts";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
const fail = (error: string): ParseResult<never> => ({ ok: false, error });

function formatScaled(amount: number, minDecimals: number, maxDecimals: number, grouping: boolean) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: minDecimals,
    maximumFractionDigits: maxDecimals,
    useGrouping: grouping,
  }).format(amount / AMOUNT_SCALE);
}

/** The number part of `formatAmount`: `1,234.50`. */
export function formatAmountValue(amount: number, currency: string) {
  const decimals = currencyDecimals(currency);
  return formatScaled(amount, decimals, decimals, true);
}

/** For display: `USD 1,234.50`, with the currency's usual decimals. */
export function formatAmount(amount: number, currency: string) {
  return `${currency} ${formatAmountValue(amount, currency)}`;
}

/**
 * For editing: just the number, without the currency or grouping, and with
 * every stored decimal so editing doesn't lose precision (`1234.5055`).
 */
export function amountEditText(amount: number, currency: string) {
  return formatScaled(amount, currencyDecimals(currency), AMOUNT_DECIMALS, false);
}

/**
 * Parses `-1,234.5` into the stored integer (-12345000). Extra decimals are
 * rounded half away from zero, on the digits rather than through floating
 * point, so `1.00005` becomes 10001.
 */
export function parseAmount(text: string): ParseResult<number> {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text.replaceAll(",", "").trim());
  if (!match || (match[2] === "" && !match[3])) return fail("Enter a number, like -12.50");

  const [, sign, whole, fraction = ""] = match;
  const digits = fraction.padEnd(AMOUNT_DECIMALS + 1, "0");
  const roundUp = Number(digits[AMOUNT_DECIMALS]) >= 5 ? 1 : 0;
  const scaled =
    Number(whole || "0") * AMOUNT_SCALE + Number(digits.slice(0, AMOUNT_DECIMALS)) + roundUp;
  if (!Number.isSafeInteger(scaled)) return fail("That amount is too large");

  return ok(sign === "-" && scaled !== 0 ? -scaled : scaled);
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
