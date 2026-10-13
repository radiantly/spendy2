import { scaleBand, scaleLinear } from "d3-scale";
import { useRef } from "react";
import { formatMoney } from "../../lib/money.ts";
import { useElementWidth } from "../../lib/useElementWidth.ts";
import { Card } from "./Card.tsx";
import { CHART_MONTHS, type Overview } from "./loadOverview.ts";
import { monthLabel } from "./period.ts";

const BARS_HEIGHT = 190;
const LABEL_HEIGHT = 24;
/** Of each month's slot, the share left as space between it and the next. */
const MONTH_PADDING = 0.2;
/** Between a month's two bars (px). */
const BAR_GAP = 4;

/** Income and spending month by month, with the period's months picked out. */
function IncomeSpendingCard({
  overview,
  className = "",
}: {
  overview: Overview;
  className?: string;
}) {
  const { months, currency } = overview;
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref);

  const x = scaleBand<string>()
    .domain(months.map(({ month }) => month))
    .range([0, width])
    .paddingInner(MONTH_PADDING);
  const most = Math.max(...months.flatMap(({ income, spent }) => [income, spent]));
  const y = scaleLinear()
    .domain([0, most || 1])
    .range([BARS_HEIGHT, 0]);
  const barWidth = Math.max(0, (x.bandwidth() - BAR_GAP) / 2);
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
      {/* Out of the flow, as in CumulativeChart. */}
      <div ref={ref} className="relative" style={{ height: BARS_HEIGHT + LABEL_HEIGHT }}>
        {width > 0 && (
          <svg
            width={width}
            height={BARS_HEIGHT + LABEL_HEIGHT}
            aria-hidden
            className="absolute inset-0"
          >
            {months.map(({ month, income, spent, inPeriod }) => {
              const left = x(month)!;
              const bars = [
                { amount: income, left, fill: "fill-ink-muted" },
                { amount: spent, left: left + barWidth + BAR_GAP, fill: "fill-coral" },
              ];
              return (
                <g key={month} opacity={inPeriod ? 1 : 0.28}>
                  {bars.map((bar) => (
                    <rect
                      key={bar.fill}
                      x={bar.left}
                      y={y(bar.amount)}
                      width={barWidth}
                      height={BARS_HEIGHT - y(bar.amount)}
                      rx={Math.min(6, barWidth / 2)}
                      className={bar.fill}
                    />
                  ))}
                  <text
                    x={left + x.bandwidth() / 2}
                    y={BARS_HEIGHT + LABEL_HEIGHT - 4}
                    textAnchor="middle"
                    className={`font-mono text-xs ${inPeriod ? "fill-ink" : "fill-ink-muted"}`}
                  >
                    {monthLabel(month)}
                  </text>
                </g>
              );
            })}
          </svg>
        )}
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
