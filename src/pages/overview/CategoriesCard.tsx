import { useId, useState } from "react";
import { FaPlay } from "react-icons/fa6";
import { formatMoney } from "../../lib/money.ts";
import { Card } from "./Card.tsx";
import type { Overview } from "./loadOverview.ts";
import { categoryColors, UNCATEGORIZED_COLOR } from "./palette.ts";
import { percent, type TopCategorySpending } from "./shape.ts";

const UNCATEGORIZED = "Uncategorized";

/** Spending by top-level category, each opening up into its subcategories. */
function CategoriesCard({ overview, className = "" }: { overview: Overview; className?: string }) {
  const { categories, currency, summary } = overview;
  const colors = categoryColors(categories);
  const colorOf = (name: string | null) =>
    name === null ? UNCATEGORIZED_COLOR : colors.get(name)!;
  const most = categories[0]?.spent ?? 0;
  const named = categories.filter(({ name }) => name !== null).length;

  return (
    <Card
      title="Where it went"
      aside={
        <span className="font-mono text-xs text-ink-muted">
          {named} {named === 1 ? "category" : "categories"}
        </span>
      }
      className={className}
    >
      {categories.length === 0 ? (
        <p className="text-ink-muted">Nothing spent in this period.</p>
      ) : (
        <>
          <div aria-hidden className="flex h-4.5 gap-0.75 overflow-hidden rounded-full">
            {categories.map(({ name, spent }) => (
              <span
                key={name ?? UNCATEGORIZED}
                style={{ flex: `${spent} 1 0`, backgroundColor: colorOf(name) }}
              />
            ))}
          </div>
          <ul className="flex flex-col">
            {categories.map((category) => (
              <CategoryRow
                key={category.name ?? UNCATEGORIZED}
                category={category}
                color={colorOf(category.name)}
                share={percent(category.spent, summary.spent)}
                barWidth={percent(category.spent, most)}
                currency={currency}
              />
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

type CategoryRowProps = {
  category: TopCategorySpending;
  color: string;
  /** Of all spending, in %. */
  share: number;
  /** Relative to the biggest category, in %. */
  barWidth: number;
  currency: string;
};

function CategoryRow({ category, color, share, barWidth, currency }: CategoryRowProps) {
  const [expanded, setExpanded] = useState(false);
  const subcategoriesId = useId();
  const { name, spent, subcategories } = category;
  const expandable = subcategories.length > 0;

  const summary = (
    <>
      <span className="flex w-full items-center gap-2 sm:gap-3">
        {/* The category's colour: a triangle that turns down when open, for
            one with subcategories, otherwise a dot. */}
        {expandable ? (
          <FaPlay
            aria-hidden
            className={`w-2.5 shrink-0 text-xs motion-safe:transition-transform ${
              expanded ? "rotate-90" : ""
            }`}
            style={{ color }}
          />
        ) : (
          <span
            aria-hidden
            className="size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: color }}
          />
        )}
        <span className="min-w-0 truncate font-semibold">{name ?? UNCATEGORIZED}</span>
        <span className="ml-auto w-10 shrink-0 text-right sm:w-12 font-mono text-sm text-ink-muted">
          {share}%
        </span>
        <span className="w-20 shrink-0 text-right sm:w-24 font-mono font-medium">
          {formatMoney(spent, currency, { whole: true })}
        </span>
      </span>
      <Bar width={barWidth} color={color} className="ml-5.5 h-1.5" />
    </>
  );

  return (
    <li className="border-t border-line">
      {expandable ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={subcategoriesId}
          onClick={() => setExpanded(!expanded)}
          className="flex w-full flex-col gap-2.5 py-3.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-focus"
        >
          {summary}
        </button>
      ) : (
        <div className="flex flex-col gap-2.5 py-3.5">{summary}</div>
      )}
      {expanded && (
        <ul id={subcategoriesId} className="flex flex-col gap-2.5 pb-4 pl-5.5">
          {subcategories.map((sub) => (
            <li
              key={sub.name}
              className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_6rem] items-center gap-3.5 text-sm"
            >
              <span>{sub.name}</span>
              <Bar
                width={percent(sub.spent, spent)}
                color={color}
                className="h-1 [&>span]:opacity-70"
              />
              <span className="text-right font-mono">
                {formatMoney(sub.spent, currency, { whole: true })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function Bar({ width, color, className }: { width: number; color: string; className: string }) {
  return (
    <span aria-hidden className={`block rounded-full bg-field ${className}`}>
      <span
        className="block h-full rounded-full"
        style={{ width: `${width}%`, backgroundColor: color }}
      />
    </span>
  );
}

export default CategoriesCard;
