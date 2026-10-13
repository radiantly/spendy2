import { formatMoney } from "../../lib/money.ts";
import { Eyebrow } from "./Card.tsx";
import CumulativeChart from "./CumulativeChart.tsx";
import type { Overview } from "./loadOverview.ts";
import { percent } from "./shape.ts";

/** How many of the biggest categories the card names. */
const TOP_CATEGORIES = 3;

/** The period's spending: the total, how it compares, where most went, and how it built up. */
function SpentCard({ overview, className = "" }: { overview: Overview; className?: string }) {
  const { period, currency, summary, previousSpent, categories, cumulative } = overview;
  const top = categories.filter(({ name }) => name !== null).slice(0, TOP_CATEGORIES);

  return (
    <section
      aria-label="Spent"
      className={`flex min-w-0 flex-col gap-5 rounded-[28px] bg-lime p-6 text-ink-on-lime lg:p-7 ${className}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2.5">
          <Eyebrow>Spent · {period.name}</Eyebrow>
          <p className="font-display text-[clamp(3.5rem,8vw,5.5rem)] leading-[0.95] font-extrabold tracking-[-0.04em]">
            {formatMoney(summary.spent, currency, { whole: true })}
          </p>
          {period.previous && previousSpent !== null && previousSpent > 0 && (
            <Change
              spent={summary.spent}
              previousSpent={previousSpent}
              label={period.previous.label}
            />
          )}
        </div>
        {top.length > 0 && (
          <div className="flex flex-col items-end gap-1.5 text-right">
            <Eyebrow>Top categories</Eyebrow>
            <ul className="flex flex-col items-end gap-1">
              {top.map(({ name, spent }) => (
                <li key={name} className="flex items-baseline gap-2.5">
                  <span className="font-medium">{name}</span>
                  <span className="font-mono font-medium">
                    {formatMoney(spent, currency, { whole: true })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="mt-auto">
        <CumulativeChart points={cumulative} currency={currency} />
      </div>
    </section>
  );
}

/** e.g. "▼ 4% vs Sep 1 – 9": less spent is good news. */
function Change({
  spent,
  previousSpent,
  label,
}: {
  spent: number;
  previousSpent: number;
  label: string;
}) {
  const change = percent(spent - previousSpent, previousSpent);
  const [arrow, color, words] =
    change < 0
      ? ["▼", "text-lime", "down"]
      : change > 0
        ? ["▲", "text-coral", "up"]
        : ["=", "text-paper", "same"];
  return (
    <p className="inline-flex items-center gap-2 self-start rounded-full bg-ink-on-lime px-3.5 py-1.5 font-mono text-sm text-paper">
      <span className={`font-medium ${color}`}>
        <span aria-hidden>{arrow}</span>
        <span className="sr-only">{words}</span> {Math.abs(change)}%
      </span>
      {label}
    </p>
  );
}

export default SpentCard;
