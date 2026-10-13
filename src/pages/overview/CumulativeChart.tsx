import { area, line } from "d3-shape";
import { scaleLinear } from "d3-scale";
import { useRef } from "react";
import { formatMoney } from "../../lib/money.ts";
import { useElementWidth } from "../../lib/useElementWidth.ts";
import { daysIn, formatDay, formatMonth } from "./period.ts";
import type { CumulativePoint } from "./shape.ts";

const HEIGHT = 180;
/** Room above the line's highest point, so the stroke isn't clipped. */
const TOP = 4;
/** Periods longer than this are labelled by month rather than day. */
const DAY_LABELS_UP_TO = 92;

type CumulativeChartProps = {
  /** From a 0 the day before the period, through every day of it. */
  points: readonly CumulativePoint[];
  currency: string;
};

/** Spending added up day by day over the period, as an area under a line. */
function CumulativeChart({ points, currency }: CumulativeChartProps) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref);

  const total = points.at(-1)!.total;
  const x = scaleLinear()
    .domain([0, points.length - 1])
    .range([0, width]);
  // With nothing spent, the line runs along the bottom.
  const y = scaleLinear()
    .domain([0, total || 1])
    .range([HEIGHT, TOP]);
  const lineAt = line<CumulativePoint>()
    .x((_, i) => x(i))
    .y((point) => y(point.total));
  const areaUnder = area<CumulativePoint>()
    .x((_, i) => x(i))
    .y0(HEIGHT)
    .y1((point) => y(point.total));

  // The point before the period is only there to start the line at 0.
  const days = points.slice(1);
  const first = days[0]!.date;
  const last = days.at(-1)!.date;
  const byDay = daysIn({ from: first, to: last }) <= DAY_LABELS_UP_TO;
  const label = (date: string) => (byDay ? formatDay(date, { year: false }) : formatMonth(date));
  const labels = [first, days[Math.floor((days.length - 1) / 2)]!.date, last];

  return (
    <div className="flex flex-col gap-3">
      {/* The chart is drawn to this box's width; out of the flow, so it
          doesn't hold the box at that width when the page narrows. */}
      <div ref={ref} className="relative h-45">
        {width > 0 && (
          <svg
            width={width}
            height={HEIGHT}
            role="img"
            aria-label={`Spending added up from ${formatDay(first)} to ${formatDay(last)}, reaching ${formatMoney(total, currency, { whole: true })}`}
            className="absolute inset-0 overflow-visible"
          >
            <path d={areaUnder(points) ?? ""} className="fill-ink-on-lime/10" />
            <path
              d={lineAt(points) ?? ""}
              className="fill-none stroke-ink-on-lime"
              strokeWidth={2.5}
              strokeLinejoin="round"
            />
          </svg>
        )}
      </div>
      <div aria-hidden className="flex justify-between font-mono text-xs font-medium">
        {labels.map((date, i) => (
          <span key={i}>{label(date)}</span>
        ))}
      </div>
    </div>
  );
}

export default CumulativeChart;
