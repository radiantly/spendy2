import type { TopCategorySpending } from "./shape.ts";

/** Top-level categories' colours, by rank in the period's spending; repeated past the last. */
const CATEGORY_COLORS = [
  "var(--color-lime)",
  "var(--color-coral)",
  "var(--color-lavender)",
  "var(--color-sky)",
  "var(--color-mint)",
  "var(--color-amber)",
];

export const UNCATEGORIZED_COLOR = "var(--color-ink-muted)";

/** Each top-level category's colour (a CSS colour), most spent first. */
export function categoryColors(categories: readonly TopCategorySpending[]) {
  const colors = new Map<string, string>();
  for (const { name } of categories)
    if (name !== null) colors.set(name, CATEGORY_COLORS[colors.size % CATEGORY_COLORS.length]!);
  return colors;
}
