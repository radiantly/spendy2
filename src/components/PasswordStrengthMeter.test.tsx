import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import PasswordStrengthMeter from "./PasswordStrengthMeter.tsx";
import { strengthResult } from "../test/fixtures.ts";

const PLACEHOLDER = "Use a long passphrase that's hard to guess.";
const LONG_ADVICE = 'Repeated character patterns like "abcabcabc" are easy to guess.';

/** Bars are decorative (aria-hidden); a filled bar uses one of the strength colours. */
function filledBars(container: HTMLElement) {
  return [...container.querySelectorAll("[aria-hidden] > span")].filter(
    (bar) => !bar.classList.contains("bg-line"),
  ).length;
}

describe("PasswordStrengthMeter", () => {
  it("shows the placeholder and no filled bars without a result", async () => {
    const screen = await render(<PasswordStrengthMeter result={null} />);

    await expect.element(screen.getByText(PLACEHOLDER)).toBeVisible();
    expect(filledBars(screen.container)).toBe(0);
  });

  it("highlights the placeholder when invalid", async () => {
    const screen = await render(<PasswordStrengthMeter result={null} invalid />);

    await expect.element(screen.getByText(PLACEHOLDER)).toHaveClass("text-danger");
  });

  it.each([0, 1, 2, 3, 4] as const)("fills %i + 1 bars for score %i", async (score) => {
    const screen = await render(<PasswordStrengthMeter result={strengthResult(score)} />);

    expect(filledBars(screen.container)).toBe(score + 1);
  });

  it("shows a summary when there is no advice", async () => {
    const screen = await render(<PasswordStrengthMeter result={strengthResult(4)} />);

    await expect.element(screen.getByText("That's a strong password!")).toBeVisible();
  });

  it("shows the level and the warning when there is one", async () => {
    const screen = await render(
      <PasswordStrengthMeter
        result={strengthResult(1, { warning: "This is a common password.", suggestions: ["Add"] })}
      />,
    );

    await expect.element(screen.getByText("Weak")).toBeVisible();
    await expect.element(screen.getByText("· This is a common password.")).toBeVisible();
  });

  it("falls back to the first suggestion without a warning", async () => {
    const screen = await render(
      <PasswordStrengthMeter
        result={strengthResult(2, { suggestions: ["Add another word.", "Avoid dates."] })}
      />,
    );

    await expect.element(screen.getByText("· Add another word.")).toBeVisible();
  });

  it("truncates long advice to one line inside a narrow parent", async () => {
    const screen = await render(
      <div style={{ width: 200 }}>
        <PasswordStrengthMeter result={strengthResult(0, { warning: LONG_ADVICE })} />
      </div>,
    );

    const advice = screen.getByTitle(LONG_ADVICE).element();
    expect(advice.scrollWidth).toBeGreaterThan(advice.clientWidth);
    const parent = screen.container.firstElementChild!;
    expect(parent.scrollWidth).toBe(parent.clientWidth);
  });
});
