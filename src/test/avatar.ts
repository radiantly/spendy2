/** What an avatar (see UserAvatar.tsx) shows, in the color scheme it's shown in. */

import { expect } from "vitest";

/** The SVG an avatar shows. */
export const avatarSvg = (img: HTMLImageElement) =>
  decodeURIComponent(img.currentSrc.slice(img.currentSrc.indexOf(",") + 1));

/** The colors an avatar's drawn in, sorted. */
export const avatarColors = (img: HTMLImageElement) =>
  [...new Set(avatarSvg(img).match(/fill="#[0-9a-f]{6}"/gi))]
    .map((fill) => fill.slice(6, -1))
    .sort();

/**
 * Waits for an avatar to be drawn in `colors`, sorted. Firefox can pick
 * the image for a color scheme a moment after it's preferred, once the
 * scheme's changed back and forth.
 */
export async function expectAvatarColors(img: HTMLImageElement, colors: string[]) {
  await expect.poll(() => avatarColors(img)).toEqual(colors);
}
