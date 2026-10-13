import { AMOUNT_SCALE } from "../db/queries/transactions.ts";

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

export type MoneyFormat = {
  /** Rounded to whole units: `$1,983` rather than `$1,982.75`. */
  whole?: boolean;
  /** Show `+` on positive amounts too. */
  signed?: boolean;
};

/**
 * A stored amount (× `AMOUNT_SCALE`) with its currency's symbol, `-$46.20`,
 * or its code where it has none, `CHF 12.00`. Text that isn't a currency
 * code goes after the number, `12.00 points`.
 */
export function formatMoney(amount: number, currency: string, { whole, signed }: MoneyFormat = {}) {
  const decimals = whole ? 0 : currencyDecimals(currency);
  const options: Intl.NumberFormatOptions = {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    signDisplay: signed ? "exceptZero" : "auto",
  };
  const value = amount / AMOUNT_SCALE;
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
