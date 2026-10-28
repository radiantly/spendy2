/**
 * Formatting and parsing for the editable transaction fields. Each `parse*`
 * turns what the user typed into the value stored in SQL, or an error to
 * show on the cell.
 */

import type { Currency } from "../../db/queries/transactions.ts";
import { decimalString, type Amount } from "../../lib/money.ts";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
const fail = (error: string): ParseResult<never> => ({ ok: false, error });

/** The parsed value passed through `map`, or the same error. */
export function mapResult<T, U>(result: ParseResult<T>, map: (value: T) => U): ParseResult<U> {
  return result.ok ? ok(map(result.value)) : result;
}

/**
 * For editing: just the number, without the currency, signed as the cell
 * shows it: `1,234.50` for money out, `+1,234.50` for money in. Grouped as
 * the cell shows it, so the number doesn't move when an edit starts; typing
 * doesn't regroup it, and `parseAmount` ignores the commas. Exactly as
 * stored, even with more decimals than the currency is usually shown with,
 * so editing it doesn't round it. Zero is empty, as `parseAmount` reads
 * empty, so a cleared amount edits as a cleared cell.
 */
export function amountEditText(amount: Amount) {
  if (amount.amount === 0) return "";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: amount.decimals,
    maximumFractionDigits: amount.decimals,
    signDisplay: amount.amount > 0 ? "exceptZero" : "never",
  }).format(decimalString(amount));
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Parses an amount, signed as the cell shows it, into one stored with
 * `decimals`: `1,234.5` is money out, -123450 with 2, and `+1,234.5` money
 * in, 123450. A minus is the same as no sign, so `-1,234.5` copied from
 * elsewhere is money out too. More decimals than that are rounded, half away
 * from zero, as the display rounds. Empty is 0, so an amount can be cleared.
 */
export function parseAmount(text: string, decimals: number): ParseResult<number> {
  if (text.trim() === "") return ok(0);
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text.replaceAll(",", "").trim());
  if (!match || (match[2] === "" && !match[3]))
    return fail("Enter an amount, like 12.50, or +12.50 for money in");

  const [, sign, whole, fraction = ""] = match;
  // BigInt, as Number would round a too-large one to a safe integer.
  let units = BigInt(`${whole}${fraction.slice(0, decimals).padEnd(decimals, "0")}` || "0");
  if ((fraction[decimals] ?? "0") >= "5") units++;
  if (units > MAX_SAFE) return fail("That amount is too large");
  // `|| 0` turns -0 (from 0, or a small amount rounded away) into 0.
  return ok(sign === "+" ? Number(units) : -Number(units) || 0);
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

/** `findName` for many texts: looks each up rather than searching `names` for it. */
export function nameFinder(names: readonly string[]): (text: string) => string | undefined {
  const exact = new Set(names);
  const folded = new Map<string, string>();
  // The first of several folding the same, as findName finds.
  for (const name of names)
    if (!folded.has(name.toLowerCase())) folded.set(name.toLowerCase(), name);
  return (text) => {
    const value = text.trim();
    return exact.has(value) ? value : folded.get(value.toLowerCase());
  };
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

/** Must be the code of one of `currencies`, ignoring case. */
export function parseCurrency(
  text: string,
  currencies: readonly Currency[],
): ParseResult<Currency> {
  const value = text.trim();
  if (value === "") return fail("Enter a currency, like USD");
  const code = findName(
    currencies.map(({ code }) => code),
    value,
  );
  const currency = currencies.find((currency) => currency.code === code);
  return currency !== undefined ? ok(currency) : fail(`There's no currency “${value}”`);
}

/** Must name one of `accounts`, ignoring case. */
export function parseAccount(text: string, accounts: readonly string[]): ParseResult<string> {
  const value = text.trim();
  if (value === "") return fail("Choose an account");
  const existing = findName(accounts, value);
  return existing !== undefined ? ok(existing) : fail(`There's no account named “${value}”`);
}
