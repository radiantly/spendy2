import { formatMoney } from "../../lib/money.ts";
import { Card } from "./Card.tsx";
import type { Overview } from "./loadOverview.ts";

/** Each account's activity over the period, in its own currency. */
function AccountsCard({ overview, className = "" }: { overview: Overview; className?: string }) {
  const { accounts } = overview;

  return (
    <Card title="Accounts" className={className}>
      {accounts.length === 0 ? (
        <p className="text-ink-muted">No accounts yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {accounts.map((account) => (
            <li
              key={account.name}
              className="flex flex-col gap-3 rounded-[20px] border border-line bg-canvas px-4.5 py-4"
            >
              <div className="flex items-center gap-2.5">
                <h3 className="font-semibold">{account.name}</h3>
                <span className="ml-auto shrink-0 font-mono text-xs text-ink-muted">
                  {account.transactions.toLocaleString("en-US")} txns
                </span>
              </div>
              <dl className="grid grid-cols-3 gap-2">
                {(
                  [
                    ["In", account.money_in, "text-gain", false],
                    ["Out", account.money_out, "text-danger", false],
                    ["Transfers", account.transfers, "", true],
                  ] as const
                ).map(([label, amount, color, signed]) => (
                  <div key={label} className="flex flex-col gap-0.5">
                    <dt className="text-xs text-ink-muted">{label}</dt>
                    <dd className={`font-mono text-sm ${color}`}>
                      {formatMoney(amount, account.currency, { whole: true, signed })}
                    </dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export default AccountsCard;
