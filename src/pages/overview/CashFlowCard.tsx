import { formatMoney } from "../../lib/money.ts";
import type { Overview } from "./loadOverview.ts";
import { percent } from "./shape.ts";

/** Money in against money out over the period. */
function CashFlowCard({ overview, className = "" }: { overview: Overview; className?: string }) {
  const { currency, summary } = overview;
  const { income, spent } = summary;
  const share = percent(spent, income);
  const net = income - spent;

  return (
    <section
      aria-label="Cash flow"
      className={`flex flex-col gap-4.5 rounded-[28px] bg-violet p-6 text-white ${className}`}
    >
      <dl className="grid grid-cols-2 gap-3">
        {(
          [
            ["Money in", income],
            ["Money out", spent],
          ] as const
        ).map(([label, amount]) => (
          <div key={label} className="flex flex-col gap-1">
            <dt className="text-sm text-white/85">{label}</dt>
            <dd className="font-display text-[2rem] font-bold tracking-tight">
              {formatMoney(amount, currency, { whole: true })}
            </dd>
          </div>
        ))}
      </dl>
      <div aria-hidden className="h-2.5 overflow-hidden rounded-full bg-white/25">
        <div
          className="h-full rounded-full bg-white"
          style={{ width: `${Math.min(100, share)}%` }}
        />
      </div>
      <p className="text-sm leading-relaxed text-white/90">
        {income > 0 ? `You spent ${share}% of what came in. ` : "Nothing came in. "}
        <strong>{formatMoney(net, currency, { whole: true, sign: "both" })}</strong> net.
      </p>
    </section>
  );
}

export default CashFlowCard;
