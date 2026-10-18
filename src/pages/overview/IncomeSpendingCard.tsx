import { formatMoney } from "../../lib/money.ts";
import { Card } from "./Card.tsx";
import { CHART_MONTHS, type Overview } from "./loadOverview.ts";
import { monthLabel } from "../../lib/period.ts";
import { percent } from "./shape.ts";

const BARS_HEIGHT = 190;

/** Income and spending month by month, with the period's months picked out. */
function IncomeSpendingCard({
  overview,
  className = "",
}: {
  overview: Overview;
  className?: string;
}) {
  const { months, currency } = overview;
  const most = Math.max(...months.flatMap(({ income, spent }) => [income, spent]));
  const money = (amount: number) => formatMoney(amount, currency, { whole: true });

  return (
    <Card
      title="Income vs. spending"
      aside={
        <div aria-hidden className="flex gap-4 text-sm text-ink-muted">
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-[3px] bg-ink-muted" />
            Income
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-[3px] bg-coral" />
            Spending
          </span>
        </div>
      }
      className={className}
    >
      <p className="-mt-3 text-sm text-ink-muted">
        Last {CHART_MONTHS} months · selected period highlighted
      </p>
      <div aria-hidden className="grid auto-cols-fr grid-flow-col gap-2">
        {months.map(({ month, income, spent, inPeriod }) => (
          <div key={month} className={`flex flex-col gap-1.5 ${inPeriod ? "" : "opacity-28"}`}>
            <div className="flex items-end gap-1" style={{ height: BARS_HEIGHT }}>
              {[
                { amount: income, color: "bg-ink-muted" },
                { amount: spent, color: "bg-coral" },
              ].map(({ amount, color }) => (
                <div
                  key={color}
                  className={`flex-1 rounded-md ${color}`}
                  style={{ height: `${percent(amount, most)}%` }}
                />
              ))}
            </div>
            <span
              className={`text-center font-mono text-xs ${inPeriod ? "text-ink" : "text-ink-muted"}`}
            >
              {monthLabel(month)}
            </span>
          </div>
        ))}
      </div>
      <ul className="sr-only">
        {months.map(({ month, income, spent, inPeriod }) => (
          <li key={month}>
            {monthLabel(month)} {month.slice(0, 4)}: income {money(income)}, spending {money(spent)}
            {inPeriod && " (in the selected period)"}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default IncomeSpendingCard;
