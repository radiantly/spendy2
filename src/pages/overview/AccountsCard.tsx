import { formatMoney } from "../../lib/money.ts";
import { Card } from "./Card.tsx";
import type { Overview } from "./loadOverview.ts";

/**
 * Each account's money in and out over the period, in its display currency.
 * An account without one has its transactions in several currencies.
 */
function AccountsCard({ overview, className = "" }: { overview: Overview; className?: string }) {
  const { accounts } = overview;

  return (
    <Card title="Accounts" className={className}>
      {accounts.length === 0 ? (
        <p className="text-ink-muted">No accounts yet.</p>
      ) : (
        <ul className="flex flex-col gap-5">
          {accounts.map((account) => (
            <li key={account.name} className="flex items-center gap-3">
              <div aria-hidden className="h-9 w-1.5 shrink-0 rounded-full bg-field" />
              <div className="flex min-w-0 grow flex-col gap-0.5">
                <h3 className="truncate font-semibold">{account.name}</h3>
                <span className="truncate font-mono text-xs text-ink-muted">
                  [{account.type}]{account.identifier !== null && ` ${account.identifier}`}
                </span>
              </div>
              {account.currency === null ? (
                <span className="shrink-0 text-sm text-ink-muted">Multiple currencies</span>
              ) : (
                <dl className="flex shrink-0 flex-col items-end gap-0.5 text-sm font-display font-semibold">
                  {(
                    [
                      ["In", account.money_in, "text-gain"],
                      ["Out", -account.money_out, "text-danger"],
                    ] as const
                  ).map(([label, amount, color]) => (
                    <div key={label} className={amount === 0 ? "text-ink-muted" : color}>
                      <dt className="sr-only">{label}</dt>
                      <dd>
                        {formatMoney(amount, account.currency, { whole: true, signed: true })}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default AccountsCard;
