/**
 * An amount as the schema stores it: `amount` in units of 10^-`decimals` of
 * its currency (the currency's stored_decimals), so 1234 with 2 is 12.34.
 */
export type Amount = { amount: number; decimals: number };

/** The exact decimal: `-12.30` for -1230 with 2 decimals. */
export function decimalString({ amount, decimals }: Amount): Intl.StringNumericLiteral {
  const digits = String(Math.abs(amount)).padStart(decimals + 1, "0");
  const point = digits.length - decimals;
  const fraction = digits.slice(point);
  // Digits with an optional sign and point: a numeric literal.
  return `${amount < 0 ? "-" : ""}${digits.slice(0, point)}${fraction && `.${fraction}`}` as Intl.StringNumericLiteral;
}

/** The number of decimals a currency is usually shown with, e.g. 2 for USD, 0 for JPY. */
export function currencyDecimals(currency: string) {
  try {
    return (
      new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    // Not an ISO 4217 code: a currency added to the database by hand.
    return 2;
  }
}

/**
 * What `Intl.NumberFormat` should format: a stored amount as its exact
 * decimal, so it rounds without a float in between (1.005 to 1.01, where the
 * float 1.005 is just below it).
 */
export function formattable(amount: number | Amount) {
  return typeof amount === "number" ? amount : decimalString(amount);
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
  amount: number | Amount,
  currency: string,
  { whole, signed }: MoneyFormat = {},
) {
  const decimals = whole ? 0 : currencyDecimals(currency);
  const options: Intl.NumberFormatOptions = {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    signDisplay: signed ? "exceptZero" : "auto",
  };
  const value = formattable(amount);
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
