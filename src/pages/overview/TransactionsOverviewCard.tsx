import { Link } from "react-router";
import { cardLinkClass, Eyebrow } from "./Card.tsx";
import type { Overview } from "./loadOverview.ts";

/**
 * What needs attention in the period's transactions: how many have no
 * category, or no amount stored in the overview's currency, those the
 * exchange rates gave one too. When none do, how many there are, and how
 * many spend money in other currencies.
 */
function TransactionsOverviewCard({
  overview,
  className = "",
}: {
  overview: Overview;
  className?: string;
}) {
  const { transactions, uncategorized, unconverted, foreign_currency_spends } = overview.summary;
  const counts = [
    uncategorized > 0
      ? { count: uncategorized, label: "uncategorized", color: "text-danger" }
      : {
          count: transactions,
          label: transactions === 1 ? "transaction" : "transactions",
          color: "",
        },
    unconverted > 0
      ? { count: unconverted, label: "not converted", color: "text-warning" }
      : { count: foreign_currency_spends, label: "foreign currency spends", color: "" },
  ];

  return (
    <section
      aria-label="Transactions overview"
      className={`flex flex-col gap-4 rounded-[28px] border border-line bg-surface p-6 ${className}`}
    >
      <Eyebrow className="text-ink-muted">Transactions overview (WIP)</Eyebrow>
      <dl className="grid grid-cols-2 gap-3">
        {counts.map(({ count, label, color }) => (
          <div key={label} className="flex flex-col-reverse justify-end gap-1">
            <dt className="text-sm text-ink-muted">{label}</dt>
            <dd className={`font-display text-[2rem] font-bold ${color}`}>
              {count.toLocaleString("en-US")}
            </dd>
          </div>
        ))}
      </dl>
      <Link to="/transactions" className={`self-start ${cardLinkClass}`}>
        See transactions →
      </Link>
    </section>
  );
}

export default TransactionsOverviewCard;
