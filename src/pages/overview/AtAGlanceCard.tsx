import { Link } from "react-router";
import { cardLinkClass, Eyebrow } from "./Card.tsx";
import type { Overview } from "./loadOverview.ts";

/** How many transactions the period has, and how many have no category. */
function AtAGlanceCard({ overview, className = "" }: { overview: Overview; className?: string }) {
  const { transactions, uncategorized } = overview.summary;
  const counts = [
    { count: transactions, label: transactions === 1 ? "transaction" : "transactions", color: "" },
    { count: uncategorized, label: "uncategorized", color: "text-danger" },
  ];

  return (
    <section
      aria-label="At a glance"
      className={`flex flex-col gap-4 rounded-[28px] border border-line bg-surface p-6 ${className}`}
    >
      <Eyebrow className="text-ink-muted">At a glance</Eyebrow>
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

export default AtAGlanceCard;
