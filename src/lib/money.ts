import { toDecimalString, type Rational } from "./rational.ts";

/** The number of decimals a currency is usually shown with, e.g. 2 for USD, 0 for JPY. */
export function currencyDecimals(currency: string) {
  try {
    return (
      new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    // Not an ISO 4217 code; the schema allows any text.
    return 2;
  }
}

/**
 * What `Intl.NumberFormat` should format to show `amount` with `decimals`
 * places: a stored amount as its exact decimal, so it rounds without a float
 * in between (1.005 to 1.01, where the float 1.005 is just below it).
 */
export function formattable(amount: number | Rational, decimals: number) {
  return typeof amount === "number" ? amount : toDecimalString(amount, decimals + 1);
}

export type MoneyFormat = {
  /** Rounded to whole units: `$1,983` rather than `$1,982.75`. */
  whole?: boolean;
  /** Show `+` on positive amounts too. */
  signed?: boolean;
};

/**
 * An amount with its currency's symbol, `-$46.20`, or its code where it has
 * none, `CHF 12.00`. Text that isn't a currency code goes after the number,
 * `12.00 points`. A stored amount is rounded exactly; a number (like a total
 * summed in SQL) is in whole units of the currency.
 */
export function formatMoney(
  amount: number | Rational,
  currency: string,
  { whole, signed }: MoneyFormat = {},
) {
  const decimals = whole ? 0 : currencyDecimals(currency);
  const options: Intl.NumberFormatOptions = {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    signDisplay: signed ? "exceptZero" : "auto",
  };
  const value = formattable(amount, decimals);
  try {
    return new Intl.NumberFormat("en-US", {
      ...options,
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
    }).format(value);
  } catch {
    return `${new Intl.NumberFormat("en-US", options).format(value)} ${currency}`;
  }
}
