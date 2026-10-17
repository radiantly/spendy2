import { Link } from "react-router";
import type { RecentTransaction } from "../../db/queries/overview.ts";
import { formatMoney } from "../../lib/money.ts";
import { Card, cardLinkClass } from "./Card.tsx";
import type { Overview } from "./loadOverview.ts";
import { categoryColors, UNCATEGORIZED_COLOR } from "./palette.ts";
import { formatDay } from "./period.ts";

/** The period's latest transactions. */
function RecentCard({ overview, className = "" }: { overview: Overview; className?: string }) {
  const { recent, categories, topCategoryOf, period, currency } = overview;
  const colors = categoryColors(categories);
  // Dates only need their year when the period spans more than one.
  const withYear = period.from.slice(0, 4) !== period.to.slice(0, 4);

  return (
    <Card
      title="Recent"
      aside={
        <Link to="/transactions" className={cardLinkClass}>
          All transactions →
        </Link>
      }
      className={`gap-1.5 ${className}`}
    >
      {recent.length === 0 ? (
        <p className="pt-3 text-ink-muted">No transactions in this period.</p>
      ) : (
        <ul className="flex flex-col pt-2.5">
          {recent.map((transaction) => (
            <li
              key={transaction.id}
              className="flex items-center gap-3.5 border-t border-line py-3"
            >
              <span
                className={`shrink-0 font-mono text-xs text-ink-muted ${withYear ? "w-24" : "w-12"}`}
              >
                {formatDay(transaction.naive_date, { year: withYear })}
              </span>
              <div className="flex min-w-0 grow flex-col gap-1">
                <span className="truncate font-medium">{transaction.counterparty}</span>
                <span className="flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
                  <CategoryChip
                    transaction={transaction}
                    color={
                      transaction.category === null
                        ? UNCATEGORIZED_COLOR
                        : colors.get(topCategoryOf(transaction.category))
                    }
                  />
                  <span>{transaction.account_name}</span>
                  {transaction.duplicate === 1 && (
                    <span className="rounded-full border border-warning px-2 py-0.5 text-warning">
                      Marked as duplicate
                    </span>
                  )}
                </span>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-0.5 font-mono">
                <span
                  className={`text-sm font-medium ${transaction.amount > 0 ? "text-gain" : ""}`}
                >
                  {formatMoney(transaction, transaction.currency, { signed: true })}
                </span>
                {transaction.conversion_amount !== null &&
                  transaction.conversion_decimals !== null && (
                    <span className="text-[11px] text-ink-muted">
                      ≈{" "}
                      {formatMoney(
                        {
                          amount: transaction.conversion_amount,
                          decimals: transaction.conversion_decimals,
                        },
                        currency,
                        { signed: true },
                      )}
                    </span>
                  )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * "Food › Groceries" in its top-level category's colour, or "Uncategorized"
 * or "Transfer". A category nothing was spent on in the period (like an
 * income one) has no colour.
 */
function CategoryChip({
  transaction,
  color,
}: {
  transaction: RecentTransaction;
  color: string | undefined;
}) {
  if (transaction.transfer_account !== null)
    return <span className="rounded-full border border-line px-2 py-0.5">Transfer</span>;

  const { category, category_parent } = transaction;
  if (category === null)
    return (
      <span className="rounded-full px-2 py-0.5 text-paper" style={{ backgroundColor: color }}>
        Uncategorized
      </span>
    );

  const label = category_parent === null ? category : `${category_parent} › ${category}`;
  return color === undefined ? (
    <span className="rounded-full bg-field px-2 py-0.5 text-ink">{label}</span>
  ) : (
    <span className="rounded-full px-2 py-0.5 text-ink-on-lime" style={{ backgroundColor: color }}>
      {label}
    </span>
  );
}

export default RecentCard;
