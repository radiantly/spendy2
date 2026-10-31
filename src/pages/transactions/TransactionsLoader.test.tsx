import { Activity } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { DatabaseContext } from "../../db/databaseContext.ts";
import { preferReducedMotion } from "../../test/media.ts";
import {
  loaderHeaderCells,
  loaderRows,
  loaderRowsBox,
  loaderShownRows,
  loaderStatus,
  loaderTable,
  loaderTexts,
} from "../../test/transactionsLoader.ts";
import { columns } from "./columns.ts";
import { LOADING, loaderRowCount, MAX_ROWS, STEP } from "./loaderCells.ts";
import TransactionsLoader from "./TransactionsLoader.tsx";

beforeEach(async () => {
  await page.viewport(1280, 800);
});

/**
 * The database, opening since `openingSince` (as performance.now()), its
 * row numbers having had `rowNumberDigits` when last opened or saved.
 */
const opening = (openingSince: number, rowNumberDigits: number | null = null) => ({
  state: { status: "loading" } as const,
  openingSince,
  rowNumberDigits,
  dirty: false,
  saving: false,
  save: async () => null,
  holdUpdates: () => () => {},
});

/** Renders the loader, the database having begun opening `ago` ms ago. */
function renderLoader(ago = 0) {
  return render(
    <DatabaseContext value={opening(performance.now() - ago)}>
      <TransactionsLoader message="Opening your database…" />
    </DatabaseContext>,
  );
}

/** How many rows the loader should show by now, the database opening since `openingSince`. */
const rowsSince = (openingSince: number) =>
  loaderRowCount(Math.floor((performance.now() - openingSince) / STEP));

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("TransactionsLoader", () => {
  it("says what it waits for, under the page's heading, the made-up table hidden from screen readers", async () => {
    await renderLoader();

    await expect.element(loaderStatus()).toHaveTextContent("Opening your database…");
    await expect.element(page.getByRole("heading", { name: "Transactions" })).toBeVisible();
    expect(loaderTable()!.getAttribute("aria-hidden")).toBe("true");
  });

  it("has the table's header", async () => {
    await renderLoader();

    expect(loaderHeaderCells().map((cell) => cell.textContent)).toEqual([
      "",
      "Date",
      "Account",
      "Counterparty",
      "Category",
      "Amount",
      "Remarks",
    ]);
  });

  it("gives the row numbers as much room as they had when last opened or saved, and its own at least", async () => {
    const openingSince = performance.now();
    const loader = (digits: number | null) => (
      <DatabaseContext value={opening(openingSince, digits)}>
        <TransactionsLoader message="Opening your database…" />
      </DatabaseContext>
    );
    const screen = await render(loader(null));
    const corner = () => loaderHeaderCells()[0]!;
    const own = corner().getBoundingClientRect().width;
    // A digit's room: tabular figures are each as wide as a 0, a `ch`.
    const probe = document.createElement("span");
    probe.style.cssText = "display: inline-block; width: 1ch";
    corner().append(probe);
    const digit = probe.getBoundingClientRect().width;
    probe.remove();

    await screen.rerender(loader(5));
    expect(corner().getBoundingClientRect().width).toBeCloseTo(own + 2 * digit, 1);

    await screen.rerender(loader(1));
    expect(corner().getBoundingClientRect().width).toBeCloseTo(own, 1);
  });

  it("shows a row more a step, numbered from 1", async () => {
    await renderLoader();
    // Only a few by now: as many as steps have passed while it rendered.
    const first = loaderShownRows();
    expect(first).toBeLessThan(MAX_ROWS / 4);

    await expect.poll(loaderShownRows).toBeGreaterThanOrEqual(first + 10);
    expect(loaderTexts().map(([number]) => number)).toEqual(
      loaderTexts().map((_, row) => String(row + 1)),
    );
  });

  it("carries on from when the database began opening, up to its most rows", async () => {
    await renderLoader(MAX_ROWS * STEP * 2);

    expect(loaderShownRows()).toBe(MAX_ROWS);
  });

  it("is as far on as the time since the database began opening, however long the page around it takes to render", async () => {
    /** Takes 10 steps to render, after the loader, as the page around it might. */
    function SlowToRender() {
      const until = performance.now() + 10 * STEP;
      while (performance.now() < until) {
        // Rendering.
      }
      return null;
    }
    const openingSince = performance.now();

    await render(
      <DatabaseContext value={opening(openingSince)}>
        <TransactionsLoader message="Opening your database…" />
        <SlowToRender />
      </DatabaseContext>,
    );
    // As it's first drawn.
    await new Promise(requestAnimationFrame);

    const [shown, expected] = [loaderShownRows(), rowsSince(openingSince)];
    // Give or take the step or two since it last moved on.
    expect(shown).toBeGreaterThanOrEqual(expected - 2);
    expect(shown).toBeLessThanOrEqual(expected);
  });

  it("is as far on as the time since the database began opening once shown, having been hidden", async () => {
    const openingSince = performance.now();
    const loader = (mode: "hidden" | "visible") => (
      <DatabaseContext value={opening(openingSince)}>
        <Activity mode={mode}>
          <TransactionsLoader message="Opening your database…" />
        </Activity>
      </DatabaseContext>
    );
    const screen = await render(loader("hidden"));
    await wait(10 * STEP);

    await screen.rerender(loader("visible"));

    const [shown, expected] = [loaderShownRows(), rowsSince(openingSince)];
    expect(shown).toBeGreaterThanOrEqual(expected - 2);
    expect(shown).toBeLessThanOrEqual(expected);
  });

  it("changes some cells as it goes, some to Loading", async () => {
    await renderLoader(MAX_ROWS * STEP * 2);
    const before = loaderTexts().flat();
    expect(before).toContain(LOADING);

    await expect
      .poll(
        () =>
          loaderTexts()
            .flat()
            .filter((text, at) => text !== before[at]).length,
      )
      .toBeGreaterThan(0);
    // Not all at once.
    const changed = loaderTexts()
      .flat()
      .filter((text, at) => text !== before[at]);
    expect(changed.length).toBeLessThan(before.length / 4);
  });

  it("only changes the cells due to change, a few a step", async () => {
    await renderLoader(MAX_ROWS * STEP * 2);
    let changes = 0;
    const observer = new MutationObserver((records) => (changes += records.length));
    observer.observe(loaderRowsBox(), { childList: true, subtree: true });
    const steps = 30;

    await wait(steps * STEP);
    changes += observer.takeRecords().length;
    observer.disconnect();

    expect(changes).toBeGreaterThan(0);
    // Each cell shows each of its texts for 60 steps or more (see
    // loaderCells.ts): changing them all each step would be 18,000.
    expect(changes).toBeLessThan(MAX_ROWS * columns.length);
  });

  it("is muted", async () => {
    await renderLoader(MAX_ROWS * STEP);
    const cell = loaderRows()[0]!.children[1]!;

    // The muted grey, #77777f.
    expect(getComputedStyle(cell).color).toBe("rgb(119, 119, 127)");
  });

  it("shows all its rows at once, and keeps them as they are, where reduced motion is preferred", async () => {
    await preferReducedMotion();
    await renderLoader();
    const before = loaderTexts();
    expect(before).toHaveLength(MAX_ROWS);

    await wait(500);

    expect(loaderTexts()).toEqual(before);
  });

  it("only says what it waits for where the table doesn't fit", async () => {
    await page.viewport(390, 800);
    await renderLoader();

    await expect.element(loaderStatus()).toBeVisible();
    await expect.element(loaderStatus()).toHaveTextContent("Opening your database…");
    expect(page.getByRole("heading").query()).toBeNull();
  });
});
