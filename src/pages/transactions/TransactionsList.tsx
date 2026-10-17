import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import type { AccountCurrency, ListedTransaction } from "../../db/queries/transactions.ts";
import type { Rational } from "../../lib/rational.ts";
import { findName, formatAmountValue } from "./fields.ts";

/** Fixed, so the virtualizer knows where everything is without measuring. */
export const DAY_HEIGHT = 40;
export const ROW_HEIGHT = 72;

type Item = { kind: "day"; date: string } | { kind: "transaction"; transaction: ListedTransaction };

/** The transactions in the order they come (newest first), each day's under a heading. */
function byDay(transactions: readonly ListedTransaction[]) {
  const items: Item[] = [];
  let day: string | undefined;
  for (const transaction of transactions) {
    if (transaction.naive_date !== day) {
      day = transaction.naive_date;
      items.push({ kind: "day", date: day });
    }
    items.push({ kind: "transaction", transaction });
  }
  return items;
}

const format = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" });
const DAY = format({ month: "short", day: "numeric" });
const DAY_WITH_YEAR = format({ month: "short", day: "numeric", year: "numeric" });
const WEEKDAY = format({ weekday: "long" });

/** "Oct 10", with the year when it isn't `thisYear`, and its weekday: "Saturday". */
function formatDay(date: string, thisYear: string) {
  const day = new Date(`${date}T00:00:00Z`);
  return {
    date: (date.startsWith(`${thisYear}-`) ? DAY : DAY_WITH_YEAR).format(day),
    weekday: WEEKDAY.format(day),
  };
}

type TransactionsListProps = {
  /** Newest first. */
  transactions: readonly ListedTransaction[];
  accounts: readonly AccountCurrency[];
};

/**
 * The transactions as a list grouped by day, for screens too narrow for the
 * table. Read-only.
 */
function TransactionsList({ transactions, accounts }: TransactionsListProps) {
  // The virtualizer is a mutable object that returns new results from the
  // same instance, so the React Compiler would memoize reads of it and render
  // stale rows (as in TransactionsTable).
  "use no memo";

  const items = useMemo(() => byDay(transactions), [transactions]);
  const displayCurrencyOf = useMemo(() => {
    const names = accounts.map(({ name }) => name);
    const currencies = new Map(accounts.map((account) => [account.name, account.display_currency]));
    // A transaction's account name matches the account's ignoring case.
    return (account: string) => currencies.get(findName(names, account) ?? "") ?? null;
  }, [accounts]);

  // The virtualizer measures scroll positions from the top of the page; it
  // needs to know where the list starts.
  const listRef = useRef<HTMLUListElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    setScrollMargin(listRef.current!.getBoundingClientRect().top + window.scrollY);
  }, []);

  const virtualizer = useWindowVirtualizer({
    count: items.length,
    // Stable until the items change, so the virtualizer only works out where
    // everything is again then.
    estimateSize: useCallback(
      (index: number) => (items[index]!.kind === "day" ? DAY_HEIGHT : ROW_HEIGHT),
      [items],
    ),
    getItemKey: useCallback(
      (index: number) => {
        const item = items[index]!;
        return item.kind === "day" ? `day ${item.date}` : item.transaction.id;
      },
      [items],
    ),
    overscan: 10,
    scrollMargin,
  });
  const thisYear = String(new Date().getFullYear());

  return (
    <ul
      ref={listRef}
      aria-label="Transactions"
      className="relative"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((virtual) => {
        const item = items[virtual.index]!;
        return (
          <li
            key={virtual.key}
            className="absolute inset-x-0 top-0"
            style={{
              height: virtual.size,
              transform: `translateY(${virtual.start - scrollMargin}px)`,
            }}
          >
            {item.kind === "day" ? (
              <DayHeading {...formatDay(item.date, thisYear)} />
            ) : (
              <TransactionItem
                transaction={item.transaction}
                displayCurrency={displayCurrencyOf(item.transaction.account_name)}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function DayHeading({ date, weekday }: { date: string; weekday: string }) {
  return (
    <h2 className="flex h-full items-end px-4 pb-1.5 font-display text-lg font-bold tracking-tight">
      {/* One line of text, so the date and weekday share a baseline. */}
      <span>
        {date}{" "}
        <span className="ml-1 font-sans text-sm font-medium tracking-normal text-ink-muted">
          {weekday}
        </span>
      </span>
    </h2>
  );
}

const amountOf = (transaction: ListedTransaction): Rational => ({
  numerator: transaction.amount_numerator,
  denominator: transaction.amount_denominator,
});

/** `+3,250.49` for money in, `-94.74` for money out. */
function signedAmount(amount: Rational, currency: string) {
  const value = formatAmountValue(amount, currency);
  return amount.numerator > 0 ? `+${value}` : value;
}

/** The transaction's amount in `currency`, if it has a conversion to it. */
function conversionTo(transaction: ListedTransaction, currency: string): Rational | undefined {
  // The query builds the JSON, so its shape is known.
  const fractions = JSON.parse(transaction.conversions) as Record<string, [number, number]>;
  const fraction = fractions[currency];
  return fraction && { numerator: fraction[0], denominator: fraction[1] };
}

/** What goes where the category usually is. */
function label(transaction: ListedTransaction) {
  if (transaction.duplicate_of !== null) return { text: "Duplicate", className: "" };
  if (transaction.transfer_account !== null) return { text: "Transfer", className: "" };
  if (transaction.category === null) return { text: "Uncategorized", className: "text-danger" };
  return { text: transaction.category, className: "" };
}

function TransactionItem({
  transaction,
  displayCurrency,
}: {
  transaction: ListedTransaction;
  /** Its account's. */
  displayCurrency: string | null;
}) {
  const amount = amountOf(transaction);
  const { text, className } = label(transaction);

  return (
    <div className="flex h-full items-center gap-3 border-b border-line px-4">
      <span
        aria-hidden
        className="grid size-10 shrink-0 place-items-center rounded-full bg-field font-semibold text-ink-muted"
      >
        {Array.from(transaction.counterparty.trim())[0]?.toUpperCase()}
      </span>
      <div className="flex min-w-0 grow flex-col gap-0.5">
        <span className="truncate font-semibold">{transaction.counterparty}</span>
        <span className="truncate text-sm text-ink-muted">
          <span className={className}>{text}</span> · {transaction.account_name}
        </span>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5 font-mono">
        <span className={amount.numerator > 0 ? "text-gain" : ""}>
          <span className="text-xs text-ink-muted">{transaction.currency}</span>{" "}
          {signedAmount(amount, transaction.currency)}
        </span>
        {displayCurrency !== null && transaction.currency !== displayCurrency && (
          <Conversion transaction={transaction} currency={displayCurrency} />
        )}
      </div>
    </div>
  );
}

/** The amount in its account's display currency, or that it has none. */
function Conversion({
  transaction,
  currency,
}: {
  transaction: ListedTransaction;
  currency: string;
}) {
  const converted = conversionTo(transaction, currency);
  return converted === undefined ? (
    <span className="font-sans text-xs text-warning">Not converted</span>
  ) : (
    <span className="text-xs text-ink-muted">
      {currency} {signedAmount(converted, currency)}
    </span>
  );
}

export default TransactionsList;
