import { useState } from "react";
import { keepPreviousData, usePrefetchQuery, useQuery } from "@tanstack/react-query";
import { useOpenDatabase } from "../../db/useDatabase.ts";
import AccountsCard from "./AccountsCard.tsx";
import { Eyebrow } from "./Card.tsx";
import CustomRangeInputs from "./CustomRangeInputs.tsx";
import CashFlowCard from "./CashFlowCard.tsx";
import CategoriesCard from "./CategoriesCard.tsx";
import IncomeSpendingCard from "./IncomeSpendingCard.tsx";
import { overviewCurrency, overviewQuery } from "./loadOverview.ts";
import { formatDay, localDate, today, type PeriodChoice } from "../../lib/period.ts";
import PeriodPicker from "./PeriodPicker.tsx";
import RecentCard from "./RecentCard.tsx";
import SpentCard from "./SpentCard.tsx";
import TransactionsOverviewCard from "./TransactionsOverviewCard.tsx";

const headingClass = "font-display text-[1.625rem] font-bold tracking-tight";
/** As tall as a custom range's underlined dates, so switching doesn't move the page. */
const headingUnderlineClass = "border-b-3 border-transparent";

function OverviewPage() {
  const { database } = useOpenDatabase();
  // Null: the period it starts on, until the first overview has found it.
  const [choice, setChoice] = useState<PeriodChoice | null>(null);
  // Null: the most used.
  const [currency, setCurrency] = useState<string | null>(null);
  const query = overviewQuery(database, choice, currency, today());
  // Started while rendering, so it loads while the page is hidden too: its
  // effects, where useQuery would start it, only run once it's shown.
  usePrefetchQuery(query);
  // The last overview stays up until the one for a new period or currency,
  // or a newer version of the database, is ready.
  const {
    data: overview,
    isPending,
    isError,
  } = useQuery({
    ...query,
    placeholderData: keepPreviousData,
  });

  if (isError)
    return (
      <p role="alert" className="m-auto text-ink">
        Couldn't load the overview.
      </p>
    );

  if (isPending)
    return (
      <p role="status" className="m-auto text-sm text-ink-muted">
        Loading overview…
      </p>
    );

  if (overview === null) return <p className="m-auto text-ink-muted">No transactions yet.</p>;
  // The period the first overview started on stays, whatever comes in after.
  // (Its overview is there under it already: see overviewQuery.)
  if (choice === null) setChoice(overview.choice);
  const chosen = choice ?? overview.choice;
  // Shown as picked straight away, while its overview loads.
  const pickedCurrency = overviewCurrency(currency, overview.currencies) ?? overview.currency;

  return (
    // The page can grow wider than the screen for content that needs it (see
    // AppShell); the overview always fits, truncating long names instead,
    // so its width mustn't depend on them. On wide screens it stops growing
    // and sits in the middle, rather than stretching the cards.
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 pb-8 contain-inline-size lg:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
        <div className="flex flex-col gap-1">
          <Eyebrow className="text-ink-muted">Showing</Eyebrow>
          {/* A custom range's dates are edited where they're shown. */}
          <h1
            className={
              chosen.kind === "custom" ? "sr-only" : `${headingClass} ${headingUnderlineClass}`
            }
          >
            {overview.period.span}
          </h1>
          {chosen.kind === "custom" && (
            <CustomRangeInputs
              range={chosen}
              onChange={(range) => setChoice({ kind: "custom", ...range })}
              className={headingClass}
            />
          )}
        </div>
        <PeriodPicker choice={chosen} current={overview.period} onChange={setChoice} />
      </div>

      {/* Two columns that stack independently, so a short card pulls the
          next one in its column up. On narrow screens they interleave into
          one, in the order of `order-*`. */}
      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(20rem,24rem)] lg:items-start">
        <div className="contents lg:flex lg:flex-col lg:gap-4">
          <SpentCard
            overview={overview}
            pickedCurrency={pickedCurrency}
            onCurrencyChange={setCurrency}
            className="order-1 lg:order-none"
          />
          <CategoriesCard overview={overview} className="order-4 lg:order-none" />
          <RecentCard overview={overview} className="order-6 lg:order-none" />
        </div>
        <div className="contents lg:flex lg:flex-col lg:gap-4">
          <CashFlowCard overview={overview} className="order-2 lg:order-none" />
          <IncomeSpendingCard overview={overview} className="order-3 lg:order-none" />
          <AccountsCard overview={overview} className="order-5 lg:order-none" />
          <TransactionsOverviewCard overview={overview} className="order-7 lg:order-none" />
        </div>
      </div>

      <p className="pt-2 font-mono text-xs text-ink-muted">
        {[
          "Decrypted locally",
          overview.lastImport !== null &&
            `last import ${formatDay(localDate(new Date(overview.lastImport * 1000)))}`,
          `amounts in ${overview.currency}, converted where noted`,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </div>
  );
}

export default OverviewPage;
