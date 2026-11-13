const counted = (count: number) =>
  `${count.toLocaleString("en-US")} foreign currency ${count === 1 ? "transaction" : "transactions"}`;

/**
 * What an amount's asterisk says (see ConversionNote): how many of the
 * transactions without a conversion stored were converted by the exchange
 * rates into it, and how many were left out of it for want of a rate. Null
 * when neither happened.
 */
export function conversionNote(estimated: number, skipped: number) {
  if (estimated > 0 && skipped > 0)
    return `${counted(estimated)} automatically converted, ${skipped.toLocaleString("en-US")} left out (missing conversions)`;
  if (estimated > 0) return `${counted(estimated)} automatically converted`;
  if (skipped > 0) return `${counted(skipped)} left out (missing conversions)`;
  return null;
}
