import { useEffect, useState, useSyncExternalStore } from "react";
import { ClosedError } from "../../db/rpc.ts";
import { useOpenDatabase } from "../../db/useDatabase.ts";
import AccountsCard from "./AccountsCard.tsx";
import AtAGlanceCard from "./AtAGlanceCard.tsx";
import { Eyebrow } from "./Card.tsx";
import CustomRangeInputs from "./CustomRangeInputs.tsx";
import CashFlowCard from "./CashFlowCard.tsx";
import CategoriesCard from "./CategoriesCard.tsx";
import IncomeSpendingCard from "./IncomeSpendingCard.tsx";
import { loadOverview, type Overview } from "./loadOverview.ts";
import { formatDay, localDate, today, type PeriodChoice } from "./period.ts";
import PeriodPicker from "./PeriodPicker.tsx";
import RecentCard from "./RecentCard.tsx";
import SpentCard from "./SpentCard.tsx";

const headingClass = "font-display text-[1.625rem] font-bold tracking-tight";
/** As tall as a custom range's underlined dates, so switching doesn't move the page. */
const headingUnderlineClass = "border-b-3 border-transparent";

type OverviewState =
  | { status: "loading" }
  | { status: "ready"; overview: Overview | null }
  | { status: "error" };

function OverviewPage() {
  const { database } = useOpenDatabase();
  const [choice, setChoice] = useState<PeriodChoice>({ kind: "this-month" });
  const [state, setState] = useState<OverviewState>({ status: "loading" });
  // Changes while this page shows come from undo and redo.
  const dataVersion = useSyncExternalStore(database.subscribe, () => database.version);

  // Loaded again for a new period, a newer version of the database, and
  // changes to the data. The last overview stays up until the next is ready.
  useEffect(() => {
    let cancelled = false;
    loadOverview(database, choice, today()).then(
      (overview) => {
        if (!cancelled) setState({ status: "ready", overview });
      },
      (error: unknown) => {
        // The database closed (e.g. on logging out), and this page with it.
        if (!cancelled && !(error instanceof ClosedError)) setState({ status: "error" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [database, choice, dataVersion]);

  if (state.status === "error")
    return (
      <p role="alert" className="m-auto text-ink">
        Couldn't load the overview.
      </p>
    );

  if (state.status === "loading")
    return (
      <p role="status" className="m-auto text-sm text-ink-muted">
        Loading overview…
      </p>
    );

  const { overview } = state;
  if (overview === null) return <p className="m-auto text-ink-muted">No transactions yet.</p>;

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
              choice.kind === "custom" ? "sr-only" : `${headingClass} ${headingUnderlineClass}`
            }
          >
            {overview.period.span}
          </h1>
          {choice.kind === "custom" && (
            <CustomRangeInputs
              range={choice}
              onChange={(range) => setChoice({ kind: "custom", ...range })}
              className={headingClass}
            />
          )}
        </div>
        <PeriodPicker choice={choice} current={overview.period} onChange={setChoice} />
      </div>

      {/* Two columns that stack independently, so a short card pulls the
          next one in its column up. On narrow screens they interleave into
          one, in the order of `order-*`. */}
      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(20rem,24rem)] lg:items-start">
        <div className="contents lg:flex lg:flex-col lg:gap-4">
          <SpentCard overview={overview} className="order-1 lg:order-none" />
          <CategoriesCard overview={overview} className="order-4 lg:order-none" />
          <RecentCard overview={overview} className="order-6 lg:order-none" />
        </div>
        <div className="contents lg:flex lg:flex-col lg:gap-4">
          <CashFlowCard overview={overview} className="order-2 lg:order-none" />
          <AtAGlanceCard overview={overview} className="order-3 lg:order-none" />
          <AccountsCard overview={overview} className="order-5 lg:order-none" />
          <IncomeSpendingCard overview={overview} className="order-7 lg:order-none" />
        </div>
      </div>

      <p className="pt-2 font-mono text-xs text-ink-muted">
        {[
          "Decrypted locally",
          overview.lastImport !== null &&
            `last import ${formatDay(localDate(new Date(overview.lastImport * 1000)))}`,
          `amounts in ${overview.currency}, converted where noted`,
          overview.summary.unconverted > 0 &&
            `${overview.summary.unconverted.toLocaleString("en-US")} in other currencies left out`,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
    </div>
  );
}

export default OverviewPage;
