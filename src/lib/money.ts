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
 * Whether a stored amount is zero at its currency's usual decimals, as
 * `formatMoney` rounds it: 0.004 USD is, 0.005 isn't.
 */
export function roundsToZero({ amount, decimals }: Amount, currency: string) {
  const hidden = decimals - currencyDecimals(currency);
  // Half of the smallest unit shown rounds away from zero, to that unit.
  return Math.abs(amount) < (hidden > 0 ? 10 ** hidden / 2 : 1);
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
  /**
   * Which amounts show their sign: money out, `-$5.00` (the default); both,
   * `-$5.00` and `+$5.00`; or money in, `+$5.00`, where most amounts are
   * money out and a minus on each would be noise, so money out is `$5.00`.
   */
  sign?: "out" | "both" | "in";
};

/** The number's part of `formatMoney`'s options. */
function numberOptions(
  amount: number | Amount,
  currency: string,
  { whole, sign = "out" }: MoneyFormat,
): Intl.NumberFormatOptions {
  const decimals = whole ? 0 : currencyDecimals(currency);
  const moneyIn = (typeof amount === "number" ? amount : amount.amount) > 0;
  const signDisplay: Record<typeof sign, Intl.NumberFormatOptions["signDisplay"]> = {
    out: "auto",
    both: "exceptZero",
    in: moneyIn ? "exceptZero" : "never",
  };
  return {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    signDisplay: signDisplay[sign],
  };
}

/**
 * An amount with its currency's symbol, `-$46.20`, or its code where it has
 * none, `CHF 12.00`. Other dollars have symbols of their own, `CA$`, so `$`
 * is only ever the US dollar. Text that isn't a currency code goes after the
 * number, `12.00 points`. A stored amount is rounded exactly; a number (like
 * a total summed in SQL) is in whole units of the currency.
 */
export function formatMoney(amount: number | Amount, currency: string, format: MoneyFormat = {}) {
  try {
    return new Intl.NumberFormat("en-US", {
      ...numberOptions(amount, currency, format),
      style: "currency",
      currency,
      currencyDisplay: "symbol",
    }).format(formattable(amount));
  } catch {
    return `${formatMoneyNumber(amount, currency, format)} ${currency}`;
  }
}

/** `formatMoney`'s number without the currency: `-46.20`, or `46.20` and `+46.20` for `sign: "in"`. */
export function formatMoneyNumber(
  amount: number | Amount,
  currency: string,
  format: MoneyFormat = {},
) {
  return new Intl.NumberFormat("en-US", numberOptions(amount, currency, format)).format(
    formattable(amount),
  );
}
