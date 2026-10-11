/**
 * The real mouse, step by step, for tests of dragging. Coordinates are in
 * the test page's viewport, like `getBoundingClientRect()`.
 */

import { commands } from "vitest/browser";
import type { Point } from "../pages/transactions/useMouseDrag.ts";

declare module "vitest/browser" {
  interface BrowserCommands {
    mouse: (action: "move" | "down" | "up", x: number, y: number) => Promise<void>;
  }
}

export const mouse = {
  move: ({ x, y }: Point) => commands.mouse("move", x, y),
  down: ({ x, y }: Point) => commands.mouse("down", x, y),
  up: ({ x, y }: Point) => commands.mouse("up", x, y),
};

/** The middle of an element, or a point that far into it (fractions of its size). */
export function pointIn(element: Element, fx = 0.5, fy = 0.5): Point {
  const box = element.getBoundingClientRect();
  return { x: box.left + box.width * fx, y: box.top + box.height * fy };
}
