/**
 * The categories as a tree, for filtering by category: each with its
 * subcategories under it.
 */

import type { CategoryParent } from "../../db/queries/overview.ts";

export type CategoryNode = { name: string; children: CategoryNode[] };

/**
 * The top-level categories, each with its subcategories, in the order of
 * `categories`. A parent is spelled as its own name is (see the queries).
 * A category in a loop of parents, which the schema prevents, is left out.
 */
export function categoryTree(categories: readonly CategoryParent[]): CategoryNode[] {
  const nodes = new Map(
    categories.map(({ name }) => [name, { name, children: [] } as CategoryNode]),
  );
  const roots: CategoryNode[] = [];
  for (const { name, parent } of categories) {
    const node = nodes.get(name)!;
    const parentNode = parent === null ? undefined : nodes.get(parent);
    // A parent that isn't listed can't be, but would leave its child at the top.
    (parentNode?.children ?? roots).push(node);
  }
  return roots;
}

/** Every category name in `node`'s tree: its own, and its subcategories'. */
export function namesIn(node: CategoryNode): string[] {
  return [node.name, ...node.children.flatMap(namesIn)];
}

/**
 * The values the filter lists for `node`'s tree, in order: each category
 * without subcategories, and under one with them, its subcategories' and
 * then its own, if some transaction is set to it (`used`).
 */
export function listedIn(node: CategoryNode, used: ReadonlySet<string | null>): string[] {
  if (node.children.length === 0) return [node.name];
  return [
    ...node.children.flatMap((child) => listedIn(child, used)),
    ...(used.has(node.name) ? [node.name] : []),
  ];
}

/** Every value the filter lists: the categories', then no category, if a transaction has none. */
export function listedValues(
  tree: readonly CategoryNode[],
  used: ReadonlySet<string | null>,
): (string | null)[] {
  return [...tree.flatMap((node) => listedIn(node, used)), ...(used.has(null) ? [null] : [])];
}
