import { useMediaQuery } from "./useMediaQuery.ts";

/**
 * Whether the screen is at least as wide as Tailwind's `breakpoint`, as its
 * `md:` (and so on) variants apply. The width is the theme's own: the
 * breakpoint must be in index.css's `@theme static`, so it's in the CSS.
 */
export function useBreakpoint(breakpoint: "md") {
  const width = getComputedStyle(document.documentElement)
    .getPropertyValue(`--breakpoint-${breakpoint}`)
    .trim();
  if (width === "")
    throw new Error(`--breakpoint-${breakpoint} isn't in the CSS: add it to @theme static`);
  return useMediaQuery(`(width >= ${width})`);
}
