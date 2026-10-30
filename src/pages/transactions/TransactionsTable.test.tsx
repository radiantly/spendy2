import {
  Activity,
  createRef,
  useImperativeHandle,
  useState,
  type ComponentProps,
  type Ref,
} from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { page, userEvent, type Locator } from "vitest/browser";
import { render } from "vitest-browser-react";
import { Toaster } from "sonner";
import type { Edit } from "../../db/databaseContext.ts";
import type { Moved } from "../../db/editHistory.ts";
import type { Currency, EditedCell, TransactionRow } from "../../db/queries/transactions.ts";
import { mouse, pointIn } from "../../test/mouse.ts";
import ActionBar from "./ActionBar.tsx";
import type { MarkKind } from "./marks.ts";
import TransactionsTable, { ROW_HEIGHT, type AddAt, type Added } from "./TransactionsTable.tsx";

const ROW_COUNT = 100_000;
const CATEGORIES = ["Dining out", "Groceries"];
const ACCOUNTS = ["Everyday Checking", "Rewards Credit Card", "Savings"];
const CURRENCIES: Currency[] = [
  { code: "EUR", stored_decimals: 2 },
  { code: "JPY", stored_decimals: 0 },
  { code: "USD", stored_decimals: 2 },
];

/** An amount edit's patch, keeping the rows' currency. */
const usd = (amount: number, decimals = 2) => ({ currency: "USD", amount, decimals });

/**
 * 1,234.50 out first, then 0.3333 in, stored with more decimals than USD is
 * shown with, then cents out.
 */
function amountOf(i: number) {
  if (i === 0) return { amount: -123_450, decimals: 2 };
  if (i === 1) return { amount: 3333, decimals: 4 };
  return { amount: -i, decimals: 2 };
}

function makeRows(count: number): TransactionRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `t${i}`,
    naive_date: "2026-10-10",
    account_name: "Everyday Checking",
    counterparty: i === 0 ? "Corner Market" : `Shop ${i}`,
    category: i % 2 === 0 ? "Groceries" : null,
    ...amountOf(i),
    currency: "USD",
    remarks: null,
    transfer_account: null,
    duplicate_of: null,
  }));
}

const rows = makeRows(ROW_COUNT);
let onCommit: Mock<ComponentProps<typeof TransactionsTable>["onCommit"]>;
let onUndoOrRedo: Mock<ComponentProps<typeof TransactionsTable>["onUndoOrRedo"]>;

beforeEach(async () => {
  onCommit = vi.fn();
  onUndoOrRedo = vi.fn();
  await page.viewport(1280, 800);
  window.scrollTo(0, 0);
});

function table(categories = CATEGORIES, shown = rows, maxRowNumber = shown.length) {
  return (
    <>
      <TransactionsTable
        rows={shown}
        maxRowNumber={maxRowNumber}
        categories={categories}
        accounts={ACCOUNTS}
        currencies={CURRENCIES}
        onCommit={onCommit}
        lastUndoOrRedo={null}
        onUndoOrRedo={onUndoOrRedo}
      />
      <Toaster />
    </>
  );
}

async function renderTable() {
  return render(table());
}

/** A point on the left half of character `index` of an element's text. */
function characterPoint(locator: Locator, index: number) {
  const element = locator.element();
  const range = document.createRange();
  range.setStart(element.firstChild!, index);
  range.setEnd(element.firstChild!, index + 1);
  const char = range.getBoundingClientRect();
  return { x: char.left + 1, y: char.top + char.height / 2 };
}

/** Double-clicks the left half of character `index` of an element's text, to edit it there. */
async function editAtCharacter(locator: Locator, index: number) {
  const point = characterPoint(locator, index);
  const box = locator.element().getBoundingClientRect();
  await userEvent.dblClick(locator, { position: { x: point.x - box.left, y: box.height / 2 } });
}

const input = () => page.getByRole("textbox");
/** An amount cell has two inputs: the number, named for its column, and the currency. */
const amountInput = () => page.getByRole("textbox", { name: "Amount" });
const currencyInput = () => page.getByRole("textbox", { name: "Currency" });
const combobox = () => page.getByRole("combobox");
const options = () =>
  page
    .getByRole("option")
    .elements()
    .map((option) => option.textContent);
const highlighted = () => page.getByRole("option", { selected: true });

/** A row's cell in `column` (0-based), after its number. */
const cellIn = (row: Element, column: number) => row.querySelectorAll('[role="gridcell"]')[column]!;
/** The number shown before a row's cells. */
const numberOf = (row: Element) => row.firstElementChild!;
/** The number of the row showing `text`. */
const numberFor = (text: string) =>
  numberOf(page.getByText(text, { exact: true }).element().closest('[role="row"]')!);

/** The cell in `column` (0-based) of the row showing `text`. */
function cellOf(text: string, column: number) {
  const row = page.getByText(text, { exact: true }).element().closest('[role="row"]')!;
  return page.elementLocator(cellIn(row, column));
}
const DATE = 0;
const ACCOUNT = 1;
const COUNTERPARTY = 2;
const CATEGORY = 3;
const AMOUNT = 4;
const REMARKS = 5;
const grid = () => page.getByRole("grid");
const activeCell = () =>
  document.getElementById(grid().element().getAttribute("aria-activedescendant") ?? "");
const headers = () => page.getByRole("columnheader").elements();
const selectedCells = () => [
  ...document.querySelectorAll('[role="gridcell"][aria-selected="true"]'),
];
const textSelection = () => {
  const element = input().element() as HTMLInputElement;
  return [element.selectionStart, element.selectionEnd];
};

/** Makes a cell active, without editing it. */
async function makeActive(text: string, column: number) {
  await userEvent.click(cellOf(text, column));
  await userEvent.keyboard("{Escape}");
  await expect.element(grid()).toHaveFocus();
}

/** Renders the table and makes a cell active, without editing it. */
async function activate(text: string, column: number) {
  await renderTable();
  await makeActive(text, column);
}

const renderedRows = () =>
  document.querySelectorAll('[role="rowgroup"] + [role="rowgroup"] > [role="row"]');
/** The colour a Tailwind text colour class gives. */
function colorOfClass(className: string) {
  const probe = document.createElement("span");
  probe.className = className;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}
/** The background colour a Tailwind class gives. */
function backgroundOfClass(className: string) {
  const probe = document.createElement("span");
  probe.className = className;
  document.body.append(probe);
  const color = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return color;
}
const backgroundOf = (element: Element) => getComputedStyle(element).backgroundColor;
/** The outline the grid draws around a range of cells. */
const rangeOutline = () =>
  document.querySelector('[role="rowgroup"] + [role="rowgroup"] > [aria-hidden] > *');
/** Presses a disabled button, as a person still can: Playwright won't, unless forced. */
const pressDisabled = (button: Locator) => userEvent.click(button, { force: true });

type TableProps = ComponentProps<typeof TransactionsTable>;

/** The table's props, showing `shown`, with `more`. */
const tableProps = (shown: TransactionRow[], more: Partial<TableProps> = {}): TableProps => ({
  rows: shown,
  maxRowNumber: shown.length,
  categories: CATEGORIES,
  accounts: ACCOUNTS,
  currencies: CURRENCIES,
  onCommit,
  lastUndoOrRedo: null,
  onUndoOrRedo,
  ...more,
});

function Changeable({
  initial,
  changeRef,
}: {
  initial: TableProps;
  changeRef: Ref<(props: TableProps) => void>;
}) {
  const [props, setProps] = useState(initial);
  useImperativeHandle(changeRef, () => setProps, []);
  return <TransactionsTable {...props} />;
}

/**
 * Renders the table with `props`, returning a function that changes them
 * as the page does once a row is written: outside a render or an event, so
 * React renders the change in a task of its own. (`rerender` changes them
 * in `act`, which runs every effect before it returns.)
 */
async function renderChangeable(props: TableProps) {
  const changeRef = createRef<(props: TableProps) => void>();
  await render(<Changeable initial={props} changeRef={changeRef} />);
  return (next: TableProps) => changeRef.current!(next);
}

/**
 * The active cell when the row showing `text` is first in the grid, as its
 * row's counterparty and its column. Mutation observers hear of a change
 * before the browser can draw it, so it's what's first drawn.
 */
function activeWhenShown(text: string) {
  return new Promise<{ row: string | null; column: number } | null>((resolve) => {
    const observer = new MutationObserver(() => {
      if (page.getByText(text, { exact: true }).query() === null) return;
      observer.disconnect();
      const cell = activeCell();
      const row = cell?.closest('[role="row"]');
      if (!cell || !row) return resolve(null);
      const cells = [...row.querySelectorAll('[role="gridcell"]')];
      resolve({ row: cells[COUNTERPARTY]!.textContent, column: cells.indexOf(cell) });
    });
    observer.observe(grid().element(), { subtree: true, childList: true, characterData: true });
  });
}

/** A row added below Shop 2's, and the rows with it. */
const ADDED: TransactionRow = { ...rows[2]!, id: "added", counterparty: "Added" };
const withAdded = rows.toSpliced(3, 0, ADDED);

describe("TransactionsTable", () => {
  describe("virtualization", () => {
    it("renders only the rows near the viewport", async () => {
      await renderTable();

      expect(page.getByRole("grid").element().getAttribute("aria-rowcount")).toBe(
        String(ROW_COUNT + 1),
      );
      expect(renderedRows().length).toBeGreaterThan(10);
      expect(renderedRows().length).toBeLessThan(100);
    });

    it("is as tall as every row would be", async () => {
      await renderTable();

      expect(document.documentElement.scrollHeight).toBeGreaterThanOrEqual(ROW_COUNT * ROW_HEIGHT);
    });

    it("shows the last rows when scrolled to the bottom", async () => {
      await renderTable();

      window.scrollTo(0, document.documentElement.scrollHeight);

      await expect.element(page.getByText(`Shop ${ROW_COUNT - 1}`)).toBeVisible();
      expect(renderedRows().length).toBeLessThan(100);
    });

    it("uses condensed rows", async () => {
      await renderTable();

      expect(page.getByText("Corner Market").element().closest('[role="row"]')!.clientHeight).toBe(
        ROW_HEIGHT,
      );
    });
  });

  describe("row numbers", () => {
    const numbers = () => [...renderedRows()].map((row) => numberOf(row).textContent);

    it("numbers the rows from 1 in the order they're shown, before their cells", async () => {
      await render(table(CATEGORIES, [rows[2]!, rows[0]!, rows[1]!]));

      await expect.poll(numbers).toEqual(["1", "2", "3"]);
      const row = renderedRows()[0]!;
      expect(cellIn(row, COUNTERPARTY).textContent).toBe("Shop 2");
      expect(row.querySelectorAll('[role="gridcell"]').length).toBe(REMARKS + 1);
      // Screen readers have the row's place from aria-rowindex.
      expect(numberOf(row).getAttribute("aria-hidden")).toBe("true");
    });

    it("fits the largest number", async () => {
      await renderTable();

      window.scrollTo(0, document.documentElement.scrollHeight);
      await expect.poll(numbers).toContain(String(ROW_COUNT));

      const widest = numberOf(renderedRows()[renderedRows().length - 1]!);
      expect(widest.textContent).toBe(String(ROW_COUNT));
      expect(widest.scrollWidth).toBeLessThanOrEqual(widest.clientWidth);
    });

    it("keeps the columns where they are, however many rows are shown", async () => {
      const screen = await render(table(CATEGORIES, rows, ROW_COUNT));
      const dateLeft = () => headers()[DATE]!.getBoundingClientRect().left;
      const before = dateLeft();

      await screen.rerender(table(CATEGORIES, rows.slice(0, 3), ROW_COUNT));

      await expect.poll(numbers).toEqual(["1", "2", "3"]);
      expect(dateLeft()).toBe(before);
    });

    it("moves through the cells from the first column, past the numbers", async () => {
      await activate("Corner Market", COUNTERPARTY);

      await userEvent.keyboard("{Home}");

      expect(activeCell()).toBe(cellOf("Corner Market", DATE).element());
    });
  });

  describe("selecting rows", () => {
    /** The cells of the rows showing `texts`. */
    const cellsOf = (...texts: string[]) =>
      texts.flatMap((text) => [
        ...page
          .getByText(text, { exact: true })
          .element()
          .closest('[role="row"]')!
          .querySelectorAll('[role="gridcell"]'),
      ]);

    it("selects a row with a press on its number, its first cell active", async () => {
      await renderTable();

      await userEvent.click(page.elementLocator(numberFor("Shop 1")));

      expect(selectedCells()).toEqual(cellsOf("Shop 1"));
      expect(activeCell()).toBe(cellOf("Shop 1", DATE).element());
      await expect.element(grid()).toHaveFocus();
    });

    it("extends to the rows from the active cell's with Shift, from their first cells", async () => {
      await activate("Shop 1", COUNTERPARTY);

      await userEvent.click(page.elementLocator(numberFor("Shop 3")), { modifiers: ["Shift"] });

      expect(selectedCells()).toEqual(cellsOf("Shop 1", "Shop 2", "Shop 3"));
      expect(activeCell()).toBe(cellOf("Shop 1", DATE).element());
    });

    it("selects the rows a drag from a number passes, wherever across them it goes", async () => {
      await renderTable();

      await mouse.down(pointIn(numberFor("Shop 1")));
      await mouse.move(pointIn(numberFor("Shop 2")));
      await mouse.move(pointIn(cellOf("Shop 3", CATEGORY).element()));
      await mouse.up(pointIn(cellOf("Shop 3", CATEGORY).element()));

      expect(selectedCells()).toEqual(cellsOf("Shop 1", "Shop 2", "Shop 3"));
      expect(activeCell()).toBe(cellOf("Shop 1", DATE).element());
    });

    it("saves an edit when a number is pressed", async () => {
      await renderTable();
      await editAtCharacter(page.getByText("Corner Market"), 0);
      await input().fill("Corner Shop");

      await userEvent.click(page.elementLocator(numberFor("Shop 2")));

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "counterparty", patch: { counterparty: "Corner Shop" } },
      ]);
      await expect.element(input()).not.toBeInTheDocument();
      expect(selectedCells()).toEqual(cellsOf("Shop 2"));
    });

    // As for any range: the transaction itself stays.
    it("clears a selected row's cells that can be empty with Delete", async () => {
      await renderTable();
      await userEvent.click(page.elementLocator(numberFor("Corner Market")));

      await userEvent.keyboard("{Delete}");

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "category", patch: { category: null } },
        { rowIndex: 0, field: "amount", patch: usd(0) },
      ]);
    });

    it("scrolls the page while a drag from a number is held at the bottom of the window", async () => {
      await renderTable();
      const start = pointIn(numberFor("Shop 5"));
      const edge = { x: start.x, y: window.innerHeight - 2 };

      await mouse.down(start);
      await mouse.move(edge);
      // It scrolls a little each animation frame, which a busy machine slows down.
      await expect.poll(() => window.scrollY, { timeout: 5000 }).toBeGreaterThan(ROW_HEIGHT * 10);
      await mouse.up(edge);

      expect(selectedCells().length).toBeGreaterThan(10 * (REMARKS + 1));
      expect(activeCell()).toBe(cellOf("Shop 5", DATE).element());
    });

    it("doesn't scroll the page for a press on a number near the bottom of the window", async () => {
      await renderTable();
      const lastVisible = [...renderedRows()]
        .filter((row) => row.getBoundingClientRect().bottom <= window.innerHeight)
        .at(-1)!;
      const box = numberOf(lastVisible).getBoundingClientRect();
      const point = { x: box.left + 5, y: box.bottom - 2 };

      await mouse.down(point);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await mouse.up(point);

      expect(window.scrollY).toBe(0);
      expect(selectedCells()).toEqual([...lastVisible.querySelectorAll('[role="gridcell"]')]);
    });
  });

  describe("highlights", () => {
    const TINT = () => backgroundOfClass("bg-focus/8");
    const NONE = "rgba(0, 0, 0, 0)";
    const headerOf = (column: number) => headers()[column]!;
    const tinted = (element: Element) => backgroundOf(element) === TINT();

    it("tints the active cell's row, number and column header, but not the active cell", async () => {
      await activate("Shop 1", COUNTERPARTY);

      expect(tinted(numberFor("Shop 1"))).toBe(true);
      expect(tinted(headerOf(COUNTERPARTY))).toBe(true);
      expect(tinted(cellOf("Shop 1", DATE).element())).toBe(true);
      expect(tinted(cellOf("Shop 1", REMARKS).element())).toBe(true);
      expect(backgroundOf(cellOf("Shop 1", COUNTERPARTY).element())).toBe(NONE);
      expect(backgroundOf(numberFor("Shop 2"))).toBe(NONE);
      expect(backgroundOf(headerOf(DATE))).toBe(NONE);
      expect(backgroundOf(cellOf("Shop 2", COUNTERPARTY).element())).toBe(NONE);
    });

    it("tints a range's numbers and headers, but not the active cell's row", async () => {
      await activate("Shop 1", COUNTERPARTY);

      await userEvent.keyboard("{Shift>}{ArrowDown}{ArrowDown}{ArrowRight}{/Shift}");

      expect(
        ["Corner Market", "Shop 1", "Shop 2", "Shop 3", "Shop 4"].map((text) =>
          tinted(numberFor(text)),
        ),
      ).toEqual([false, true, true, true, false]);
      expect(headers().map(tinted)).toEqual([false, false, true, true, false, false]);
      expect(backgroundOf(cellOf("Shop 1", DATE).element())).toBe(NONE);
      expect(backgroundOf(cellOf("Shop 2", COUNTERPARTY).element())).toBe(
        backgroundOfClass("bg-focus/15"),
      );
    });

    it("highlights nothing without an active cell", async () => {
      await activate("Corner Market", COUNTERPARTY);

      // Up from the first row makes the column's header active instead.
      await userEvent.keyboard("{ArrowUp}");

      expect(activeCell()).toBe(headerOf(COUNTERPARTY));
      expect(headers().some(tinted)).toBe(false);
      expect(backgroundOf(numberFor("Corner Market"))).toBe(NONE);
      expect(backgroundOf(cellOf("Corner Market", DATE).element())).toBe(NONE);
    });
  });

  describe("display", () => {
    const amountShown = (counterparty: string) =>
      cellOf(counterparty, AMOUNT).element().textContent;

    it("shows an amount with its currency's symbol, without a sign for money out", async () => {
      await renderTable();

      expect(amountShown("Corner Market")).toBe("$1,234.50");
    });

    it("shows money in with a plus", async () => {
      await renderTable();

      expect(amountShown("Shop 1")).toBe("+$0.33");
    });

    it("shows the active cell's amount as the others, splitting it only to edit it", async () => {
      await activate("Corner Market", AMOUNT);

      expect(amountShown("Corner Market")).toBe("$1,234.50");
    });
  });

  describe("the note after the remarks", () => {
    /** The rows, with `marks` set on some of them, by index. */
    const marked = (marks: Record<number, Partial<TransactionRow>>) =>
      rows.map((row, index) => ({ ...row, ...marks[index] }));
    const text = (value: string) => page.getByText(value, { exact: true });
    const remarksShown = (counterparty: string) =>
      cellOf(counterparty, REMARKS).element().textContent;
    // Shop 1's money in, and Shop 2's out.
    const transfers = () =>
      marked({
        1: { remarks: "Refund", transfer_account: "Savings" },
        2: { transfer_account: "Savings" },
      });

    it("says which way a transfer went, greyed and in italics, after the remarks", async () => {
      await render(table(CATEGORIES, transfers()));

      expect(remarksShown("Shop 1")).toBe("Refund Transfer from Savings.");
      expect(remarksShown("Shop 2")).toBe("Transfer to Savings.");
      const styleOf = (value: string) => {
        const { color, fontStyle } = getComputedStyle(text(value).element());
        return { color, fontStyle };
      };
      const muted = colorOfClass("text-ink-muted");
      expect(styleOf("Transfer from Savings.")).toEqual({ color: muted, fontStyle: "italic" });
      expect(styleOf("Refund").color).not.toBe(muted);
      expect(styleOf("Refund").fontStyle).toBe("normal");
    });

    it("says which row a duplicate's original is, as they're numbered, or that it's hidden", async () => {
      // Shop 3 is a duplicate of Shop 1, row 2.
      const shown = marked({ 3: { duplicate_of: "t1" } });
      const screen = await render(table(CATEGORIES, shown));
      expect(remarksShown("Shop 3")).toBe("Duplicate of transaction 2.");

      await screen.rerender(table(CATEGORIES, shown.slice(1)));
      expect(remarksShown("Shop 3")).toBe("Duplicate of transaction 1.");
      await screen.rerender(table(CATEGORIES, shown.slice(2)));
      expect(remarksShown("Shop 3")).toBe("Duplicate of a hidden transaction.");
    });

    it("goes while the remarks are edited, from their end when it's pressed", async () => {
      await render(table(CATEGORIES, transfers()));
      await makeActive("Shop 1", REMARKS);

      await userEvent.click(text("Transfer from Savings."));

      await expect.element(input()).toHaveValue("Refund");
      expect(textSelection()).toEqual([6, 6]);
      await expect.element(text("Transfer from Savings.")).not.toBeInTheDocument();
    });

    it("leaves a cell with only a note edited at once when pressed, as an empty one is", async () => {
      await render(table(CATEGORIES, transfers()));

      await userEvent.click(text("Transfer to Savings."));

      await expect.element(input()).toHaveFocus();
      expect(input().element()).toHaveProperty("value", "");
      await expect.element(text("Transfer to Savings.")).not.toBeInTheDocument();
    });
  });

  describe("editing", () => {
    it("turns a cell into an input on double-click, with the caret where it was pressed", async () => {
      await renderTable();

      await editAtCharacter(page.getByText("Corner Market"), 3);

      await expect.element(input()).toHaveFocus();
      expect(input().element()).toHaveProperty("value", "Corner Market");
      expect(textSelection()).toEqual([3, 3]);
    });

    it("only makes a cell with something in it active on a click", async () => {
      await renderTable();

      await userEvent.click(cellOf("Corner Market", COUNTERPARTY));

      expect(activeCell()).toBe(cellOf("Corner Market", COUNTERPARTY).element());
      await expect.element(grid()).toHaveFocus();
      await expect.element(input()).not.toBeInTheDocument();
    });

    it("edits an empty cell straight away on a click", async () => {
      await renderTable();

      await userEvent.click(cellOf("Corner Market", REMARKS));

      await expect.element(input()).toHaveFocus();
      expect(input().element()).toHaveProperty("value", "");
    });

    it("edits the active cell on a click, with the caret where it was pressed", async () => {
      await activate("Corner Market", COUNTERPARTY);
      const text = page.getByText("Corner Market");
      const point = characterPoint(text, 3);
      const box = text.element().getBoundingClientRect();

      await userEvent.click(text, { position: { x: point.x - box.left, y: box.height / 2 } });

      await expect.element(input()).toHaveFocus();
      expect(textSelection()).toEqual([3, 3]);
    });

    it("makes a cell in a range active on a click, without editing it", async () => {
      await activate("Corner Market", COUNTERPARTY);
      await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");

      await userEvent.click(cellOf("Corner Market", COUNTERPARTY));

      expect(selectedCells()).toHaveLength(1);
      await expect.element(input()).not.toBeInTheDocument();
    });

    it("edits an amount's number grouped as shown, with the caret where it was pressed", async () => {
      await renderTable();

      // Before the "2" in "$1,234.50".
      await editAtCharacter(page.getByText("$1,234.50"), 3);

      expect(amountInput().element()).toHaveProperty("value", "1,234.50");
      expect((amountInput().element() as HTMLInputElement).selectionStart).toBe(2);
    });

    it("edits money in with its plus", async () => {
      await renderTable();

      // Before the "3" in "+$0.33".
      await editAtCharacter(page.getByText("+$0.33"), 4);

      expect(amountInput().element()).toHaveProperty("value", "+0.3333");
      expect((amountInput().element() as HTMLInputElement).selectionStart).toBe(3);
    });

    it("doesn't regroup the number while it's typed", async () => {
      await activate("Corner Market", AMOUNT);

      await userEvent.keyboard("{F2}{Home}{Delete}");

      expect(amountInput().element()).toHaveProperty("value", ",234.50");
      await userEvent.keyboard("{Enter}");
      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "amount", patch: usd(-23_450) },
      ]);
    });

    it("commits on Enter", async () => {
      await renderTable();
      await editAtCharacter(page.getByText("Corner Market"), 0);

      await input().fill("Corner Shop");
      await userEvent.keyboard("{Enter}");

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "counterparty", patch: { counterparty: "Corner Shop" } },
      ]);
      await expect.element(input()).not.toBeInTheDocument();
    });

    it("parses the value before committing", async () => {
      await renderTable();
      await editAtCharacter(page.getByText("$1,234.50"), 1);

      await amountInput().fill("2,000.5");
      await userEvent.keyboard("{Enter}");

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "amount", patch: usd(-200_050) },
      ]);
    });

    it.each([
      ["45", -4500],
      ["-45", -4500],
      ["+45", 4500],
    ])(
      "saves %j as money out without a sign or with a minus, in with a plus",
      async (text, amount) => {
        await renderTable();
        await editAtCharacter(page.getByText("$1,234.50"), 1);

        await amountInput().fill(text);
        await userEvent.keyboard("{Enter}");

        expect(onCommit).toHaveBeenCalledWith([
          { rowIndex: 0, field: "amount", patch: usd(amount) },
        ]);
      },
    );

    it("starts an edit of the number on a plus typed into the cell", async () => {
      await activate("Corner Market", AMOUNT);

      await userEvent.keyboard("+");

      await expect.element(amountInput()).toHaveFocus();
      expect(amountInput().element()).toHaveProperty("value", "+");
      await userEvent.keyboard("45{Enter}");
      expect(onCommit).toHaveBeenCalledWith([{ rowIndex: 0, field: "amount", patch: usd(4500) }]);
    });

    it("rounds what's typed to the decimals the amount is stored with", async () => {
      await renderTable();
      await editAtCharacter(page.getByText("$1,234.50"), 1);

      await amountInput().fill("2,000.505");
      await userEvent.keyboard("{Enter}");

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "amount", patch: usd(-200_051) },
      ]);
    });

    it("commits when the input loses focus", async () => {
      await renderTable();
      await editAtCharacter(page.getByText("Corner Market"), 0);

      await input().fill("Corner Shop");
      input().element().blur();

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "counterparty", patch: { counterparty: "Corner Shop" } },
      ]);
    });

    it("reverts on Escape", async () => {
      await renderTable();
      await editAtCharacter(page.getByText("Corner Market"), 0);

      await input().fill("Corner Shop");
      await userEvent.keyboard("{Escape}");

      await expect.element(input()).not.toBeInTheDocument();
      expect(onCommit).not.toHaveBeenCalled();
      await expect.element(page.getByText("Corner Market")).toBeVisible();
    });

    it("doesn't commit an unchanged value", async () => {
      await renderTable();
      await editAtCharacter(page.getByText("Corner Market"), 0);

      await userEvent.keyboard("{Enter}");

      expect(onCommit).not.toHaveBeenCalled();
    });

    it("shows an amount with more decimals than its currency rounded", async () => {
      await renderTable();

      await expect.element(page.getByText("+$0.33", { exact: true })).toBeVisible();
    });

    it("edits an amount with more decimals than its currency exactly, so leaving it changes nothing", async () => {
      await renderTable();
      await editAtCharacter(page.getByText("+$0.33", { exact: true }), 2);

      expect(amountInput().element()).toHaveProperty("value", "+0.3333");
      await userEvent.keyboard("{Enter}");

      expect(onCommit).not.toHaveBeenCalled();
    });

    it("keeps an edited amount in the decimals it's stored with", async () => {
      await renderTable();
      await editAtCharacter(page.getByText("+$0.33", { exact: true }), 2);

      await amountInput().fill("+0.33");
      await userEvent.keyboard("{Enter}");

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 1, field: "amount", patch: usd(3300, 4) },
      ]);
    });

    it.each(["1234.5", " 1234.50 ", "1,234.50", "-1,234.50"])(
      "doesn't commit the same amount written as %j",
      async (text) => {
        await renderTable();
        await editAtCharacter(page.getByText("$1,234.50"), 1);

        await amountInput().fill(text);
        await userEvent.keyboard("{Enter}");

        expect(onCommit).not.toHaveBeenCalled();
      },
    );

    it("doesn't commit a counterparty that only gained spaces", async () => {
      await renderTable();
      await editAtCharacter(page.getByText("Corner Market"), 0);

      await input().fill("Corner Market ");
      await userEvent.keyboard("{Enter}");

      expect(onCommit).not.toHaveBeenCalled();
    });

    it("saves an emptied amount as 0", async () => {
      await renderTable();
      await editAtCharacter(page.getByText("$1,234.50"), 1);

      await amountInput().fill("");
      await userEvent.keyboard("{Enter}");

      expect(onCommit).toHaveBeenCalledWith([{ rowIndex: 0, field: "amount", patch: usd(0) }]);
    });

    it("keeps an invalid value open with the error on Enter", async () => {
      await renderTable();
      await editAtCharacter(page.getByText("$1,234.50"), 1);

      await amountInput().fill("1.2.3");
      await userEvent.keyboard("{Enter}");

      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("Enter an amount, like 12.50, or +12.50 for money in");
      await expect.element(amountInput()).toHaveAttribute("aria-invalid", "true");
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("outlines the edited cell in red while its value is invalid", async () => {
      await renderTable();
      await editAtCharacter(page.getByText("$1,234.50"), 1);
      const outline = () => getComputedStyle(activeCell()!).outlineColor;
      const valid = outline();

      await amountInput().fill("1.2.3");
      await userEvent.keyboard("{Enter}");
      await expect.element(page.getByRole("alert")).toBeVisible();

      expect(outline()).toBe(colorOfClass("text-danger"));
      await userEvent.keyboard("{Backspace}");
      expect(outline()).toBe(valid);
    });

    it("undoes an invalid value on blur and says why", async () => {
      await renderTable();
      await editAtCharacter(page.getByText("Corner Market"), 0);

      await input().fill("");
      input().element().blur();

      await expect
        .element(page.getByText("Enter a counterparty. The change was undone."))
        .toBeVisible();
      await expect.element(input()).not.toBeInTheDocument();
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("commits the open edit when another cell is pressed", async () => {
      await renderTable();
      await editAtCharacter(page.getByText("Corner Market"), 0);
      await input().fill("Corner Shop");

      await userEvent.click(cellOf("Shop 1", COUNTERPARTY));

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "counterparty", patch: { counterparty: "Corner Shop" } },
      ]);
      expect(activeCell()).toBe(cellOf("Shop 1", COUNTERPARTY).element());
      await expect.element(input()).not.toBeInTheDocument();
    });

    it("keeps the edited row when it scrolls out of view", async () => {
      await renderTable();
      await editAtCharacter(page.getByText("Corner Market"), 0);
      await input().fill("Corner Shop");
      // Firefox scrolls the caret into view a frame after fill(), which a
      // user's scrolling never comes before.
      await new Promise((resolve) => requestAnimationFrame(resolve));

      window.scrollTo(0, document.documentElement.scrollHeight);
      await expect.element(page.getByText(`Shop ${ROW_COUNT - 1}`)).toBeInTheDocument();

      expect(input().element()).toHaveProperty("value", "Corner Shop");
    });

    it("lets the mouse wheel scroll the page away from the cell being edited", async () => {
      await renderTable();
      await editAtCharacter(page.getByText("Shop 2"), 0);

      for (let i = 0; i < 5; i++) {
        await userEvent.wheel(grid(), { delta: { y: 300 } });
        // Frames between ticks, as between a user's.
        for (let frame = 0; frame < 3; frame++)
          await new Promise((resolve) => requestAnimationFrame(resolve));
      }

      await expect.poll(() => window.scrollY).toBe(1500);
    });

    it("moves to the cell below after Enter, with the grid focused", async () => {
      await renderTable();
      await editAtCharacter(page.getByText("Corner Market"), 0);
      await input().fill("Corner Shop");

      await userEvent.keyboard("{Enter}");

      await expect.element(input()).not.toBeInTheDocument();
      await expect.element(grid()).toHaveFocus();
      expect(activeCell()).toBe(cellOf("Shop 1", COUNTERPARTY).element());
    });

    it("moves to the cell above after Shift+Enter", async () => {
      await renderTable();
      await editAtCharacter(page.getByText("Shop 2"), 0);
      await input().fill("Shop Two");

      await userEvent.keyboard("{Shift>}{Enter}{/Shift}");

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 2, field: "counterparty", patch: { counterparty: "Shop Two" } },
      ]);
      await expect.element(input()).not.toBeInTheDocument();
      expect(activeCell()).toBe(cellOf("Shop 1", COUNTERPARTY).element());
    });

    it("edits an empty cell below straight away after Enter", async () => {
      await renderTable();
      await userEvent.click(cellOf("Corner Market", REMARKS));
      await input().fill("Weekly shop");

      await userEvent.keyboard("{Enter}");

      await expect.element(input()).toHaveFocus();
      expect(input().element()).toHaveProperty("value", "");
      expect(activeCell()).toBe(cellOf("Shop 1", REMARKS).element());
      await userEvent.keyboard("Rent{Enter}");
      expect(onCommit).toHaveBeenLastCalledWith([
        { rowIndex: 1, field: "remarks", patch: { remarks: "Rent" } },
      ]);
      expect(activeCell()).toBe(cellOf("Shop 2", REMARKS).element());
    });

    it("moves to the cell below after Enter on an unchanged value", async () => {
      await renderTable();
      await editAtCharacter(page.getByText("Corner Market"), 0);

      await userEvent.keyboard("{Enter}");

      await expect.element(input()).not.toBeInTheDocument();
      expect(activeCell()).toBe(cellOf("Shop 1", COUNTERPARTY).element());
    });

    it("stays on an invalid value after Enter", async () => {
      await renderTable();
      await editAtCharacter(page.getByText("$1,234.50"), 1);
      await amountInput().fill("1.2.3");

      await userEvent.keyboard("{Enter}");

      await expect.element(amountInput()).toHaveAttribute("aria-invalid", "true");
      expect(activeCell()).toBe(cellOf("Corner Market", AMOUNT).element());
    });

    it("keeps the last row's cell active after Enter", async () => {
      await activate("Corner Market", COUNTERPARTY);
      await userEvent.keyboard("{Control>}{ArrowDown}{/Control}");
      await expect.element(page.getByText(`Shop ${ROW_COUNT - 1}`)).toBeInTheDocument();
      await userEvent.keyboard("{F2}");

      await userEvent.keyboard("{Enter}");

      await expect.element(input()).not.toBeInTheDocument();
      expect(activeCell()).toBe(cellOf(`Shop ${ROW_COUNT - 1}`, COUNTERPARTY).element());
    });

    it("keeps the cell active after Escape", async () => {
      await renderTable();
      await editAtCharacter(page.getByText("Corner Market"), 0);

      await userEvent.keyboard("{Escape}");

      await expect.element(grid()).toHaveFocus();
      expect(activeCell()).toBe(cellOf("Corner Market", COUNTERPARTY).element());
    });
  });

  describe("currency", () => {
    const currency = () => currencyInput().element() as HTMLInputElement;
    const amount = () => amountInput().element() as HTMLInputElement;
    const committed = (patch: { currency: string; amount: number; decimals: number }) =>
      expect(onCommit).toHaveBeenCalledWith([{ rowIndex: 0, field: "amount", patch }]);

    it("edits the currency in an input of its own, before the number's", async () => {
      await renderTable();

      await editAtCharacter(page.getByText("$1,234.50"), 1);

      expect(currency().value).toBe("USD");
      expect(amount().value).toBe("1,234.50");
      await expect.element(amountInput()).toHaveFocus();
    });

    it("keeps the number where the cell showed it, with the currency before it", async () => {
      await activate("Corner Market", AMOUNT);
      // Where the number ends, as it's right-aligned. (WebKit snaps a
      // character's box to whole pixels, so where it starts can't be measured.)
      const numberRight = page.getByText("$1,234.50").element().getBoundingClientRect().right;

      await userEvent.keyboard("{F2}{End}");
      await userEvent.click(currencyInput());
      await userEvent.keyboard("{End}");

      const number = amount().getBoundingClientRect();
      expect(number.right).toBeCloseTo(numberRight, 0);
      expect(currency().getBoundingClientRect().right).toBeLessThan(number.left);
      // A caret at the end fits, without scrolling the text.
      expect([currency().scrollLeft, amount().scrollLeft]).toEqual([0, 0]);
    });

    it("switches to the currency, cleared, on a letter typed into the number", async () => {
      await renderTable();
      await editAtCharacter(page.getByText("$1,234.50"), 1);

      await userEvent.keyboard("eur");

      await expect.element(currencyInput()).toHaveFocus();
      expect(currency().value).toBe("eur");
      expect(amount().value).toBe("1,234.50");
      await userEvent.keyboard("{Enter}");
      committed({ currency: "EUR", amount: -123_450, decimals: 2 });
    });

    it("switches back to the number, cleared, on a digit typed into the currency", async () => {
      await activate("Corner Market", AMOUNT);

      await userEvent.keyboard("{F2}JPY12");

      await expect.element(amountInput()).toHaveFocus();
      expect(currency().value).toBe("JPY");
      expect(amount().value).toBe("12");
      await userEvent.keyboard("{Enter}");
      committed({ currency: "JPY", amount: -12, decimals: 0 });
    });

    it.each([
      ["EUR{Enter}", -123_450],
      ["EUR5{Enter}", -500],
      ["EUR 5{Enter}", -500],
      ["EUR {Enter}", -123_450],
    ])(
      "starts a new currency on a letter typed into the cell, keeping the amount until a number is typed: %s",
      async (keys, amount) => {
        await activate("Corner Market", AMOUNT);

        await userEvent.keyboard(keys);

        committed({ currency: "EUR", amount, decimals: 2 });
      },
    );

    it("starts the edit in the currency on a letter typed into the cell", async () => {
      await activate("Corner Market", AMOUNT);

      await userEvent.keyboard("E");

      await expect.element(currencyInput()).toHaveFocus();
      expect(currency().value).toBe("E");
      expect(amount().value).toBe("1,234.50");
    });

    it("deletes from the currency with Backspace", async () => {
      await activate("Corner Market", AMOUNT);

      await userEvent.keyboard("EUX{Backspace}R");

      expect(currency().value).toBe("EUR");
      expect(amount().value).toBe("1,234.50");
    });

    it("moves between the inputs on a click, carrying on with the edit", async () => {
      await activate("Corner Market", AMOUNT);
      await userEvent.keyboard("EU");

      await userEvent.click(amountInput());
      await expect.element(amountInput()).toHaveFocus();
      await userEvent.click(currencyInput());

      await expect.element(currencyInput()).toHaveFocus();
      expect([currency().value, amount().value]).toEqual(["EU", "1,234.50"]);
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("splits pasted text into the currency and the number", async () => {
      await renderTable();
      await editAtCharacter(page.getByText("$1,234.50"), 1);

      await amountInput().fill("EUR 12.50");

      expect(currency().value).toBe("EUR");
      expect(amount().value).toBe("12.50");
    });

    it("doesn't commit the same currency typed in another case", async () => {
      await activate("Corner Market", AMOUNT);

      await userEvent.keyboard("usd{Enter}");

      expect(onCommit).not.toHaveBeenCalled();
    });

    it("keeps an unknown currency open with the error", async () => {
      await activate("Corner Market", AMOUNT);

      await userEvent.keyboard("XYZ{Enter}");

      await expect.element(page.getByRole("alert")).toHaveTextContent("There's no currency “XYZ”");
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("keeps the transaction's currency when the currency is left empty", async () => {
      await activate("Corner Market", AMOUNT);

      await userEvent.keyboard("E{Backspace}5{Enter}");

      committed({ currency: "USD", amount: -500, decimals: 2 });
    });

    it("doesn't commit an emptied currency with the same number", async () => {
      await activate("Corner Market", AMOUNT);

      await userEvent.keyboard("E{Backspace}{Enter}");

      expect(onCommit).not.toHaveBeenCalled();
      await expect.element(currencyInput()).not.toBeInTheDocument();
    });
  });

  describe("zero amounts", () => {
    const currency = () => currencyInput().element() as HTMLInputElement;
    const amount = () => amountInput().element() as HTMLInputElement;
    const amountShown = (counterparty: string) =>
      cellOf(counterparty, AMOUNT).element().textContent;

    /** Renders the table with row `index`'s amount (Corner Market's, at 0) set. */
    async function renderWithAmount(amount: number, decimals = 2, index = 0) {
      return render(table(CATEGORIES, rows.with(index, { ...rows[index]!, amount, decimals })));
    }

    it("shows a zero amount as an empty cell", async () => {
      await renderWithAmount(0);

      expect(amountShown("Corner Market")).toBe("");
    });

    it.each([33, -33])(
      "shows an amount that rounds to zero as an empty cell too: %d ten-thousandths",
      async (units) => {
        await renderWithAmount(units, 4);

        expect(amountShown("Corner Market")).toBe("");
      },
    );

    it("edits a zero amount on a press, as an empty cell, from an empty number", async () => {
      await renderWithAmount(0);

      await userEvent.click(cellOf("Corner Market", AMOUNT));

      await expect.element(amountInput()).toHaveFocus();
      expect([currency().value, amount().value]).toEqual(["USD", ""]);
    });

    it("edits an amount that rounds to zero on a press, showing it exactly", async () => {
      await renderWithAmount(33, 4);

      await userEvent.click(cellOf("Corner Market", AMOUNT));

      await expect.element(amountInput()).toHaveFocus();
      expect(amount().value).toBe("+0.0033");
    });

    it("edits a zero amount when Enter moves onto it", async () => {
      await renderWithAmount(0, 2, 1);
      await makeActive("Corner Market", AMOUNT);

      await userEvent.keyboard("{Enter}");

      await expect.element(amountInput()).toHaveFocus();
      expect(activeCell()).toBe(cellOf("Shop 1", AMOUNT).element());
    });

    it("doesn't commit a zero amount left empty", async () => {
      await renderWithAmount(0);
      await userEvent.click(cellOf("Corner Market", AMOUNT));

      await userEvent.keyboard("{Enter}");

      expect(onCommit).not.toHaveBeenCalled();
    });

    it("commits a zero amount's new currency, still 0", async () => {
      await renderWithAmount(0);
      await userEvent.click(cellOf("Corner Market", AMOUNT));

      await userEvent.keyboard("EUR{Enter}");

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "amount", patch: { currency: "EUR", amount: 0, decimals: 2 } },
      ]);
    });
  });

  describe("keyboard", () => {
    it("starts at the first cell when the grid is tabbed into", async () => {
      await renderTable();

      await userEvent.tab();

      await expect.element(grid()).toHaveFocus();
      expect(activeCell()?.textContent).toBe("2026-10-10");
    });

    it("makes a column header active, not a cell, when it's clicked", async () => {
      await renderTable();

      await userEvent.click(page.getByRole("columnheader").first());

      expect(activeCell()).toBe(headers()[DATE]);
      expect(selectedCells()).toEqual([]);
    });

    it("moves the active cell with the arrow keys", async () => {
      await activate("Corner Market", COUNTERPARTY);

      await userEvent.keyboard("{ArrowRight}{ArrowDown}");

      expect(activeCell()).toBe(cellOf("Shop 1", CATEGORY).element());
      await userEvent.keyboard("{ArrowLeft}{ArrowLeft}{ArrowUp}");
      expect(activeCell()).toBe(cellOf("Corner Market", ACCOUNT).element());
    });

    it("stops at the edges", async () => {
      await activate("Corner Market", DATE);

      await userEvent.keyboard("{ArrowLeft}{Control>}{ArrowUp}{/Control}");

      expect(activeCell()).toBe(cellOf("Corner Market", DATE).element());
    });

    it("goes up from the first row to its column's header", async () => {
      await activate("Corner Market", COUNTERPARTY);

      await userEvent.keyboard("{ArrowUp}");

      expect(activeCell()).toBe(headers()[COUNTERPARTY]);
      expect(selectedCells()).toEqual([]);
    });

    it("moves along the headers, stopping at the ends", async () => {
      await activate("Corner Market", DATE);

      await userEvent.keyboard("{ArrowUp}{ArrowLeft}");
      expect(activeCell()).toBe(headers()[DATE]);
      await userEvent.keyboard("{ArrowRight}{ArrowRight}");
      expect(activeCell()).toBe(headers()[COUNTERPARTY]);
      await userEvent.keyboard("{End}{ArrowRight}");
      expect(activeCell()).toBe(headers()[REMARKS]);
      await userEvent.keyboard("{Home}");
      expect(activeCell()).toBe(headers()[DATE]);
    });

    it("goes back down from a header to its column's first cell", async () => {
      await activate("Corner Market", DATE);

      await userEvent.keyboard("{ArrowUp}{ArrowRight}{ArrowDown}");

      expect(activeCell()).toBe(cellOf("Corner Market", ACCOUNT).element());
    });

    it("doesn't edit or clear from a header", async () => {
      await activate("Corner Market", COUNTERPARTY);

      await userEvent.keyboard("{ArrowUp}a{Delete}{F2}");

      expect(input().query()).toBeNull();
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("does nothing on Enter on a header, without menus", async () => {
      await activate("Corner Market", COUNTERPARTY);

      await userEvent.keyboard("{ArrowUp}{Enter}");

      expect(activeCell()).toBe(headers()[COUNTERPARTY]);
      expect(page.getByRole("dialog").query()).toBeNull();
    });

    it("starts at the first header when a grid without rows is tabbed into", async () => {
      await render(
        <TransactionsTable
          rows={[]}
          maxRowNumber={0}
          categories={CATEGORIES}
          accounts={ACCOUNTS}
          currencies={CURRENCIES}
          onCommit={onCommit}
          lastUndoOrRedo={null}
          onUndoOrRedo={onUndoOrRedo}
        />,
      );

      await userEvent.tab();

      await expect.element(grid()).toHaveFocus();
      expect(activeCell()).toBe(headers()[DATE]);
    });

    it("starts editing with F2, caret at the end", async () => {
      await activate("Corner Market", COUNTERPARTY);

      await userEvent.keyboard("{F2}");

      await expect.element(input()).toHaveFocus();
      expect(input().element()).toHaveProperty("value", "Corner Market");
      expect((input().element() as HTMLInputElement).selectionStart).toBe("Corner Market".length);
    });

    it("moves down with Enter, only making a cell with something in it active", async () => {
      await activate("Corner Market", COUNTERPARTY);

      await userEvent.keyboard("{Enter}");

      expect(activeCell()).toBe(cellOf("Shop 1", COUNTERPARTY).element());
      expect(input().query()).toBeNull();
      await expect.element(grid()).toHaveFocus();
    });

    it("moves up with Shift+Enter", async () => {
      await activate("Shop 2", COUNTERPARTY);

      await userEvent.keyboard("{Shift>}{Enter}{/Shift}");

      expect(activeCell()).toBe(cellOf("Shop 1", COUNTERPARTY).element());
      expect(input().query()).toBeNull();
    });

    it("edits an empty cell moved onto with Enter", async () => {
      await activate("Corner Market", CATEGORY);

      await userEvent.keyboard("{Enter}");

      await expect.element(combobox()).toHaveFocus();
      expect(combobox().element()).toHaveProperty("value", "");
      expect(activeCell()).toBe(cellOf("Shop 1", CATEGORY).element());
    });

    it("edits an empty cell moved onto with Shift+Enter", async () => {
      await activate("Shop 2", CATEGORY);

      await userEvent.keyboard("{Shift>}{Enter}{/Shift}");

      await expect.element(combobox()).toHaveFocus();
      expect(activeCell()).toBe(cellOf("Shop 1", CATEGORY).element());
    });

    it("stays on the first row with Shift+Enter, without editing", async () => {
      await activate("Corner Market", REMARKS);

      await userEvent.keyboard("{Shift>}{Enter}{/Shift}");

      expect(activeCell()).toBe(cellOf("Corner Market", REMARKS).element());
      expect(input().query()).toBeNull();
    });

    it("moves down from the active cell with Enter, dropping the range", async () => {
      await activate("Corner Market", DATE);
      await userEvent.keyboard("{Shift>}{ArrowRight}{ArrowDown}{/Shift}");

      await userEvent.keyboard("{Enter}");

      expect(activeCell()).toBe(cellOf("Shop 1", DATE).element());
      expect(selectedCells()).toEqual([cellOf("Shop 1", DATE).element()]);
    });

    it("replaces the content with what's typed", async () => {
      await activate("Corner Market", COUNTERPARTY);

      await userEvent.keyboard("Z");

      await expect.element(input()).toHaveFocus();
      expect(input().element()).toHaveProperty("value", "Z");
      expect((input().element() as HTMLInputElement).selectionStart).toBe(1);
      await userEvent.keyboard("oo{Enter}");
      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "counterparty", patch: { counterparty: "Zoo" } },
      ]);
    });

    it("filters a combobox's menu by what's typed", async () => {
      await activate("Corner Market", ACCOUNT);

      await userEvent.keyboard("s");

      expect(combobox().element()).toHaveProperty("value", "s");
      expect(options()).toEqual(["Rewards Credit Card", "Savings"]);
      await expect.element(highlighted()).toHaveTextContent("Rewards Credit Card");
    });

    it("starts editing for a character typed with AltGr", async () => {
      await activate("Corner Market", COUNTERPARTY);

      // Windows reports AltGr as Ctrl+Alt as well. The real key can't be
      // pressed from a test, as it depends on the keyboard layout.
      grid()
        .element()
        .dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "@",
            ctrlKey: true,
            altKey: true,
            modifierAltGraph: true,
            bubbles: true,
          }),
        );

      await expect.element(input()).toHaveFocus();
      expect(input().element()).toHaveProperty("value", "@");
    });

    it("doesn't start editing for Ctrl+Alt shortcuts", async () => {
      await activate("Corner Market", COUNTERPARTY);

      grid()
        .element()
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "k", ctrlKey: true, altKey: true, bubbles: true }),
        );

      await expect.element(input()).not.toBeInTheDocument();
    });

    it("doesn't start editing for shortcuts", async () => {
      await activate("Corner Market", COUNTERPARTY);

      await userEvent.keyboard("{Control>}c{/Control}");

      await expect.element(input()).not.toBeInTheDocument();
    });

    it("saves with Tab and moves to the next cell", async () => {
      await renderTable();
      await editAtCharacter(page.getByText("Corner Market"), 0);
      await input().fill("Corner Shop");

      await userEvent.keyboard("{Tab}");

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "counterparty", patch: { counterparty: "Corner Shop" } },
      ]);
      await expect.element(input()).not.toBeInTheDocument();
      await expect.element(grid()).toHaveFocus();
      expect(activeCell()).toBe(cellOf("Corner Market", CATEGORY).element());
    });

    it("saves with Shift+Tab and moves to the previous cell", async () => {
      await renderTable();
      await editAtCharacter(page.getByText("Corner Market"), 0);
      await input().fill("Corner Shop");

      await userEvent.keyboard("{Shift>}{Tab}{/Shift}");

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "counterparty", patch: { counterparty: "Corner Shop" } },
      ]);
      expect(activeCell()).toBe(cellOf("Corner Market", ACCOUNT).element());
    });

    it("keeps an invalid value open with the error on Tab", async () => {
      await renderTable();
      await editAtCharacter(page.getByText("$1,234.50"), 1);

      await amountInput().fill("1.2.3");
      await userEvent.keyboard("{Tab}");

      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("Enter an amount, like 12.50, or +12.50 for money in");
      await expect.element(amountInput()).toHaveFocus();
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("moves between cells with Tab", async () => {
      await activate("Corner Market", COUNTERPARTY);

      await userEvent.keyboard("{Tab}");
      expect(activeCell()).toBe(cellOf("Corner Market", CATEGORY).element());
      await userEvent.keyboard("{Shift>}{Tab}{Tab}{/Shift}");
      expect(activeCell()).toBe(cellOf("Corner Market", ACCOUNT).element());
    });

    it("wraps Tab from the last column to the next row's first, and Shift+Tab back", async () => {
      await activate("Corner Market", REMARKS);

      await userEvent.keyboard("{Tab}");
      expect(activeCell()).toBe(cellOf("Shop 1", DATE).element());
      await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
      expect(activeCell()).toBe(cellOf("Corner Market", REMARKS).element());
    });

    it("wraps Tab after an edit in the last column", async () => {
      await renderTable();
      await userEvent.dblClick(cellOf("Corner Market", REMARKS));

      await input().fill("Weekly shop");
      await userEvent.keyboard("{Tab}");

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "remarks", patch: { remarks: "Weekly shop" } },
      ]);
      expect(activeCell()).toBe(cellOf("Shop 1", DATE).element());
    });

    it("lets Tab leave the grid from its last cell", async () => {
      // Somewhere after the grid for focus to go: past the end of the page,
      // where it goes differs between browsers.
      await render(
        <>
          {table()}
          <button type="button">After the table</button>
        </>,
      );
      await makeActive("Corner Market", DATE);
      await userEvent.keyboard("{Control>}{End}{/Control}");

      await userEvent.keyboard("{Tab}");

      await expect.element(page.getByRole("button", { name: "After the table" })).toHaveFocus();
    });

    it("goes to the start and end of the row with Home and End", async () => {
      await activate("Corner Market", COUNTERPARTY);

      await userEvent.keyboard("{End}");
      expect(activeCell()).toBe(cellOf("Corner Market", REMARKS).element());
      await userEvent.keyboard("{Home}");
      expect(activeCell()).toBe(cellOf("Corner Market", DATE).element());
    });

    it("selects to the end of the row with Shift+End", async () => {
      await activate("Corner Market", AMOUNT);

      await userEvent.keyboard("{Shift>}{End}{/Shift}");

      expect(selectedCells()).toEqual([
        cellOf("Corner Market", AMOUNT).element(),
        cellOf("Corner Market", REMARKS).element(),
      ]);
    });

    it("goes to the grid's last and first cell with Ctrl+End and Ctrl+Home", async () => {
      await activate("Shop 3", COUNTERPARTY);

      await userEvent.keyboard("{Control>}{End}{/Control}");

      await expect.element(page.getByText(`Shop ${ROW_COUNT - 1}`)).toBeInTheDocument();
      expect(activeCell()).toBe(cellOf(`Shop ${ROW_COUNT - 1}`, REMARKS).element());
      await userEvent.keyboard("{Control>}{Home}{/Control}");
      await expect.element(page.getByText("Corner Market")).toBeInTheDocument();
      expect(activeCell()).toBe(cellOf("Corner Market", DATE).element());
    });

    it("jumps to the grid's edges with Ctrl and the arrow keys", async () => {
      await activate("Shop 3", COUNTERPARTY);

      await userEvent.keyboard("{Control>}{ArrowLeft}{/Control}");
      expect(activeCell()).toBe(cellOf("Shop 3", DATE).element());
      await userEvent.keyboard("{Control>}{ArrowUp}{/Control}");
      expect(activeCell()).toBe(cellOf("Corner Market", DATE).element());
      await userEvent.keyboard("{Control>}{ArrowDown}{/Control}");
      await expect.element(page.getByText(`Shop ${ROW_COUNT - 1}`)).toBeInTheDocument();
      expect(activeCell()).toBe(cellOf(`Shop ${ROW_COUNT - 1}`, DATE).element());
    });

    it("moves a page at a time with Page Down and Page Up, keeping the cell where it was on screen", async () => {
      await activate("Shop 3", COUNTERPARTY);
      const before = activeCell()!.getBoundingClientRect().top;

      await userEvent.keyboard("{PageDown}");

      const page1 =
        Number(activeCell()!.closest('[role="row"]')!.getAttribute("aria-rowindex")) - 2;
      expect(page1).toBeGreaterThan(10);
      await expect.poll(() => activeCell()!.getBoundingClientRect().top).toBeCloseTo(before, 0);
      await userEvent.keyboard("{PageUp}");
      expect(activeCell()).toBe(cellOf("Shop 3", COUNTERPARTY).element());
    });

    it("leaves the arrow keys to the input while editing", async () => {
      await renderTable();
      const cell = cellOf("Corner Market", COUNTERPARTY).element();
      await editAtCharacter(page.getByText("Corner Market"), 0);

      await userEvent.keyboard("{ArrowRight}{ArrowDown}");

      await expect.element(input()).toHaveFocus();
      expect((input().element() as HTMLInputElement).selectionStart).toBe("Corner Market".length);
      expect(activeCell()).toBe(cell);
    });

    it("selects a range from the active cell with Shift and the arrow keys", async () => {
      await activate("Corner Market", COUNTERPARTY);

      await userEvent.keyboard("{Shift>}{ArrowDown}{ArrowDown}{ArrowRight}{/Shift}");

      expect(selectedCells()).toEqual([
        cellOf("Corner Market", COUNTERPARTY).element(),
        cellOf("Corner Market", CATEGORY).element(),
        cellOf("Shop 1", COUNTERPARTY).element(),
        cellOf("Shop 1", CATEGORY).element(),
        cellOf("Shop 2", COUNTERPARTY).element(),
        cellOf("Shop 2", CATEGORY).element(),
      ]);
      expect(activeCell()).toBe(cellOf("Corner Market", COUNTERPARTY).element());
    });

    it.each([
      ["a column", "{ArrowDown}".repeat(5), "Shop 10", COUNTERPARTY],
      [
        "a range to the last column",
        "{ArrowDown}{ArrowRight}{ArrowRight}{ArrowRight}",
        "Shop 6",
        REMARKS,
      ],
    ])(
      "outlines %s around its cells' boxes, where the active cell's outline is",
      async (_, keys, lastText, lastColumn) => {
        await activate("Shop 5", COUNTERPARTY);

        await userEvent.keyboard(`{Shift>}${keys}{/Shift}`);

        const outline = rangeOutline()!.getBoundingClientRect();
        const first = cellOf("Shop 5", COUNTERPARTY).element().getBoundingClientRect();
        const last = cellOf(lastText, lastColumn).element().getBoundingClientRect();
        // Firefox can differ in the last digits, adding up the columns a box spans.
        expect([outline.left, outline.top, outline.right, outline.bottom]).toEqual(
          [first.left, first.top, last.right, last.bottom].map((edge) => expect.closeTo(edge, 2)),
        );
      },
    );

    it("drops the range with Escape", async () => {
      await activate("Corner Market", COUNTERPARTY);
      await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");

      await userEvent.keyboard("{Escape}");

      expect(selectedCells()).toEqual([cellOf("Corner Market", COUNTERPARTY).element()]);
      expect(rangeOutline()).toBeNull();
    });

    it("drops the range when an arrow key moves the active cell", async () => {
      await activate("Corner Market", COUNTERPARTY);
      await userEvent.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}");

      await userEvent.keyboard("{ArrowRight}");

      expect(selectedCells()).toEqual([cellOf("Corner Market", CATEGORY).element()]);
    });

    it("scrolls the active cell into view, below the sticky header", async () => {
      await activate("Shop 5", COUNTERPARTY);
      window.scrollTo(0, document.documentElement.scrollHeight);
      await expect.element(page.getByText(`Shop ${ROW_COUNT - 1}`)).toBeInTheDocument();

      await userEvent.keyboard("{ArrowDown}");

      await expect.element(page.getByText("Shop 6", { exact: true })).toBeInTheDocument();
      const header = page.getByRole("columnheader").first().element().getBoundingClientRect();
      const cell = cellOf("Shop 6", COUNTERPARTY).element();
      expect(cell.getBoundingClientRect().top).toBeGreaterThanOrEqual(header.bottom - 1);
      expect(cell.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
      expect(activeCell()).toBe(cell);
    });

    it("keeps pointing at the active cell when it scrolls out of view", async () => {
      await activate("Shop 5", COUNTERPARTY);

      window.scrollTo(0, document.documentElement.scrollHeight);
      await expect.element(page.getByText(`Shop ${ROW_COUNT - 1}`)).toBeInTheDocument();

      expect(activeCell()?.textContent).toBe("Shop 5");
    });

    it("scrolls a column into view sideways", async () => {
      await page.viewport(500, 800);
      await activate("Corner Market", DATE);

      await userEvent.keyboard("{ArrowRight}".repeat(5));

      const box = activeCell()!.getBoundingClientRect();
      expect(box.right).toBeLessThanOrEqual(document.documentElement.clientWidth);
      expect(box.left).toBeGreaterThanOrEqual(0);
    });
  });

  describe("clearing", () => {
    it("starts editing empty text on Backspace", async () => {
      await activate("Corner Market", COUNTERPARTY);

      await userEvent.keyboard("{Backspace}");

      await expect.element(input()).toHaveFocus();
      expect(input().element()).toHaveProperty("value", "");
      await userEvent.keyboard("{Escape}");
      await expect.element(page.getByText("Corner Market")).toBeVisible();
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("starts editing on Backspace even in a cell that can be empty", async () => {
      await activate("Corner Market", CATEGORY);

      await userEvent.keyboard("{Backspace}");

      await expect.element(combobox()).toHaveFocus();
      expect(combobox().element()).toHaveProperty("value", "");
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("empties a cell that can be empty on Delete, keeping it active", async () => {
      await activate("Corner Market", CATEGORY);

      await userEvent.keyboard("{Delete}");

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "category", patch: { category: null } },
      ]);
      await expect.element(combobox()).not.toBeInTheDocument();
      await expect.element(grid()).toHaveFocus();
      expect(activeCell()).toBe(cellOf("Corner Market", CATEGORY).element());
    });

    it("sets an amount to 0 on Delete, keeping it active", async () => {
      await activate("Corner Market", AMOUNT);

      await userEvent.keyboard("{Delete}");

      expect(onCommit).toHaveBeenCalledWith([{ rowIndex: 0, field: "amount", patch: usd(0) }]);
      await expect.element(input()).not.toBeInTheDocument();
      expect(activeCell()).toBe(cellOf("Corner Market", AMOUNT).element());
    });

    it("starts editing empty text on Delete in a cell that can't be empty", async () => {
      await activate("Corner Market", COUNTERPARTY);

      await userEvent.keyboard("{Delete}");

      await expect.element(input()).toHaveFocus();
      expect(input().element()).toHaveProperty("value", "");
      expect(onCommit).not.toHaveBeenCalled();
    });

    it.each(["{Delete}", "{Backspace}"])(
      "empties only the cells of a range that can be empty, all at once, on %s",
      async (key) => {
        await activate("Corner Market", COUNTERPARTY);
        await userEvent.keyboard("{Shift>}{ArrowDown}{ArrowDown}{ArrowRight}{ArrowRight}{/Shift}");

        await userEvent.keyboard(key);

        // Rows 0 and 2 have a category (row 1 has none to clear); an
        // emptied amount is 0; counterparties can't be empty.
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(onCommit).toHaveBeenCalledWith([
          { rowIndex: 0, field: "category", patch: { category: null } },
          { rowIndex: 2, field: "category", patch: { category: null } },
          { rowIndex: 0, field: "amount", patch: usd(0) },
          { rowIndex: 1, field: "amount", patch: usd(0, 4) },
          { rowIndex: 2, field: "amount", patch: usd(0) },
        ]);
        await expect.element(input()).not.toBeInTheDocument();
        expect(selectedCells()).toHaveLength(9);
      },
    );

    it("does nothing for a range with nothing to empty", async () => {
      await activate("Corner Market", COUNTERPARTY);
      await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");

      await userEvent.keyboard("{Delete}");

      expect(onCommit).not.toHaveBeenCalled();
      await expect.element(input()).not.toBeInTheDocument();
    });
  });

  describe("undo and redo", () => {
    /** An undo of an edit to `cells` (row index and field), as the history reports it. */
    const undone = (cells: [number, EditedCell["field"]][]): Moved<Edit> => ({
      direction: "undo",
      step: {
        changes: Promise.resolve(new Uint8Array()),
        about: {
          kind: "transaction",
          cells: cells.map(([row, field]) => ({ id: `t${row}`, field })),
          transactions: [...new Set(cells.map(([row]) => `t${row}`))],
          description: "an edit",
        },
      },
    });

    const tableShowing = (moved: Moved<Edit> | null) => (
      <TransactionsTable
        rows={rows}
        maxRowNumber={rows.length}
        categories={CATEGORIES}
        accounts={ACCOUNTS}
        currencies={CURRENCIES}
        onCommit={onCommit}
        lastUndoOrRedo={moved}
        onUndoOrRedo={onUndoOrRedo}
      />
    );

    it("selects the cells an undo or redo changed", async () => {
      const screen = await render(tableShowing(null));
      await makeActive("Shop 9", REMARKS);

      await screen.rerender(
        tableShowing(
          undone([
            [3, "category"],
            [1, "counterparty"],
          ]),
        ),
      );

      expect(activeCell()).toBe(cellOf("Shop 1", COUNTERPARTY).element());
      expect(selectedCells()).toEqual([
        cellOf("Shop 1", COUNTERPARTY).element(),
        cellOf("Shop 1", CATEGORY).element(),
        cellOf("Shop 2", COUNTERPARTY).element(),
        cellOf("Shop 2", CATEGORY).element(),
        cellOf("Shop 3", COUNTERPARTY).element(),
        cellOf("Shop 3", CATEGORY).element(),
      ]);
    });

    it("scrolls the cells it changed into view", async () => {
      const screen = await render(tableShowing(null));

      await screen.rerender(tableShowing(undone([[500, "amount"]])));

      await expect.element(cellOf("Shop 500", AMOUNT)).toBeInViewport();
      expect(activeCell()).toBe(cellOf("Shop 500", AMOUNT).element());
    });

    it("has the cells a redo brings back selected from when they're first drawn", async () => {
      const change = await renderChangeable(tableProps(rows));
      await makeActive("Shop 2", CATEGORY);
      const shown = activeWhenShown("Added");

      change(
        tableProps(withAdded, {
          lastUndoOrRedo: {
            direction: "redo",
            step: {
              changes: Promise.resolve(new Uint8Array()),
              about: {
                kind: "transaction",
                cells: (["naive_date", "counterparty", "remarks"] as const).map((field) => ({
                  id: ADDED.id,
                  field,
                })),
                transactions: [ADDED.id],
                description: "adding a transaction",
              },
            },
          },
        }),
      );

      expect(await shown).toEqual({ row: "Added", column: DATE });
    });

    it("selects them once, not again on later renders", async () => {
      const moved = undone([[3, "counterparty"]]);
      const screen = await render(tableShowing(moved));
      await makeActive("Shop 1", DATE);

      await screen.rerender(tableShowing(moved));

      expect(activeCell()).toBe(cellOf("Shop 1", DATE).element());
    });

    it("selects them again for another undo or redo of the same edit", async () => {
      const moved = undone([[3, "counterparty"]]);
      const screen = await render(tableShowing(moved));
      await makeActive("Shop 1", DATE);

      await screen.rerender(tableShowing({ ...moved, direction: "redo" }));

      expect(activeCell()).toBe(cellOf("Shop 3", COUNTERPARTY).element());
    });

    it.each([
      ["{Control>}z{/Control}", "undo"],
      ["{Control>}y{/Control}", "redo"],
    ] as const)(
      "takes %s in a cell being edited as %s while its text is unchanged, finishing the edit",
      async (keys, direction) => {
        await renderTable();
        await userEvent.dblClick(cellOf("Corner Market", COUNTERPARTY));

        await userEvent.keyboard(keys);

        expect(onUndoOrRedo.mock.calls).toEqual([[direction]]);
        await expect.element(input()).not.toBeInTheDocument();
        expect(onCommit).not.toHaveBeenCalled();
        await expect.element(grid()).toHaveFocus();
      },
    );

    it("leaves Ctrl+Z to the input once its text has changed", async () => {
      await renderTable();
      await userEvent.dblClick(cellOf("Corner Market", COUNTERPARTY));
      await userEvent.keyboard("{End}s");

      await userEvent.keyboard("{Control>}z{/Control}");

      expect(onUndoOrRedo).not.toHaveBeenCalled();
      await expect.element(input()).toHaveFocus();
    });

    it.each([
      ["typing", "x", "x"],
      ["Backspace", "{Backspace}", ""],
    ])(
      "leaves Ctrl+Z to the input in an edit started by %s, keeping the edit",
      async (_, keys, text) => {
        await renderTable();
        await makeActive("Corner Market", COUNTERPARTY);
        await userEvent.keyboard(keys);
        await expect.element(input()).toHaveValue(text);

        await userEvent.keyboard("{Control>}z{/Control}");

        expect(onUndoOrRedo).not.toHaveBeenCalled();
        await expect.element(input()).toHaveFocus();
        await expect.element(input()).toHaveValue(text);
      },
    );
  });

  describe("the action bar's undo and redo", () => {
    const undoButton = () => page.getByRole("button", { name: "Undo" });
    const redoButton = () => page.getByRole("button", { name: "Redo" });

    /** The table with its action bar, with a change to undo and one to redo unless said. */
    const withBar = ({ canUndo = true, canRedo = true } = {}) => (
      <TransactionsTable
        rows={rows}
        maxRowNumber={rows.length}
        categories={CATEGORIES}
        accounts={ACCOUNTS}
        currencies={CURRENCIES}
        onCommit={onCommit}
        lastUndoOrRedo={null}
        onUndoOrRedo={onUndoOrRedo}
        actionBar={{
          canUndo,
          canRedo,
          add: null,
          deleteRows: () => {},
          mark: () => null,
          unmark: () => {},
          render: (actions) => <ActionBar {...actions} />,
        }}
      />
    );

    /** What was saved, undone and redone, in order. */
    function recordCalls() {
      const calls: string[] = [];
      onCommit.mockImplementation(
        (changes) => void calls.push(`commit ${JSON.stringify(changes)}`),
      );
      onUndoOrRedo.mockImplementation((direction) => void calls.push(direction));
      return calls;
    }

    it.each([
      ["Undo", "undo"],
      ["Redo", "redo"],
    ] as const)(
      "%s asks to %s the table's last change, keeping focus in the grid",
      async (name, direction) => {
        await render(withBar());
        await makeActive("Shop 1", COUNTERPARTY);
        const button = page.getByRole("button", { name });
        await expect.element(button).not.toHaveAttribute("aria-disabled");

        await userEvent.click(button);

        expect(onUndoOrRedo.mock.calls).toEqual([[direction]]);
        await expect.element(grid()).toHaveFocus();
      },
    );

    it.each(["Undo", "Redo"])("disables %s while there's nothing for it", async (name) => {
      await render(withBar({ canUndo: false, canRedo: false }));
      await makeActive("Shop 1", COUNTERPARTY);
      const button = page.getByRole("button", { name });
      await expect.element(button).toHaveAttribute("aria-disabled", "true");

      await pressDisabled(button);

      expect(onUndoOrRedo).not.toHaveBeenCalled();
    });

    describe("while a cell is being edited", () => {
      it.each([
        ["Undo", "undo"],
        ["Redo", "redo"],
      ] as const)(
        "%s finishes an unchanged edit first, keeping its cell active",
        async (name, direction) => {
          await render(withBar());
          await userEvent.dblClick(cellOf("Corner Market", COUNTERPARTY));

          await userEvent.click(page.getByRole("button", { name }));

          expect(onUndoOrRedo.mock.calls).toEqual([[direction]]);
          expect(onCommit).not.toHaveBeenCalled();
          await expect.element(input()).not.toBeInTheDocument();
          expect(activeCell()).toBe(cellOf("Corner Market", COUNTERPARTY).element());
          await expect.element(grid()).toHaveFocus();
        },
      );

      it("disables Undo for an unchanged edit while there's nothing to undo", async () => {
        await render(withBar({ canUndo: false }));

        await userEvent.dblClick(cellOf("Corner Market", COUNTERPARTY));

        await expect.element(undoButton()).toHaveAttribute("aria-disabled", "true");
      });

      it("saves a changed edit and undoes it, even with nothing else to undo", async () => {
        await render(withBar({ canUndo: false }));
        const calls = recordCalls();
        await userEvent.dblClick(cellOf("Corner Market", COUNTERPARTY));
        await userEvent.keyboard("{End}s");

        await userEvent.click(undoButton());

        expect(calls).toEqual([
          `commit ${JSON.stringify([
            { rowIndex: 0, field: "counterparty", patch: { counterparty: "Corner Markets" } },
          ])}`,
          "undo",
        ]);
        await expect.element(input()).not.toBeInTheDocument();
        expect(activeCell()).toBe(cellOf("Corner Market", COUNTERPARTY).element());
        await expect.element(grid()).toHaveFocus();
      });

      it("saves an edit started by typing and undoes it", async () => {
        await render(withBar());
        const calls = recordCalls();
        await makeActive("Shop 1", COUNTERPARTY);
        await userEvent.keyboard("Shop 9");

        await userEvent.click(undoButton());

        expect(calls).toEqual([
          `commit ${JSON.stringify([
            { rowIndex: 1, field: "counterparty", patch: { counterparty: "Shop 9" } },
          ])}`,
          "undo",
        ]);
      });

      it("undoes the change before an edit that comes to the cell's own value", async () => {
        await render(withBar());
        await makeActive("Shop 1", COUNTERPARTY);
        await userEvent.keyboard("Shop 1");

        await userEvent.click(undoButton());

        expect(onCommit).not.toHaveBeenCalled();
        expect(onUndoOrRedo.mock.calls).toEqual([["undo"]]);
      });

      it("drops a changed edit that can't be saved, undoing nothing", async () => {
        await render(withBar());
        await editAtCharacter(page.getByText("$1,234.50"), 1);
        await amountInput().fill("1.2.3");

        await userEvent.click(undoButton());

        await expect.element(amountInput()).not.toBeInTheDocument();
        expect(onCommit).not.toHaveBeenCalled();
        expect(onUndoOrRedo).not.toHaveBeenCalled();
        expect(activeCell()).toBe(cellOf("Corner Market", AMOUNT).element());
        await expect.element(grid()).toHaveFocus();
      });

      it("drops a category typed in it rather than creating it", async () => {
        await render(withBar());
        await userEvent.dblClick(cellOf("Shop 1", CATEGORY));
        await combobox().fill("Pets");

        await userEvent.click(undoButton());

        await expect.element(combobox()).not.toBeInTheDocument();
        expect(onCommit).not.toHaveBeenCalled();
        expect(onUndoOrRedo).not.toHaveBeenCalled();
      });

      it("disables Redo while an edit has changed its cell", async () => {
        await render(withBar());
        await userEvent.dblClick(cellOf("Corner Market", COUNTERPARTY));
        await expect.element(redoButton()).not.toHaveAttribute("aria-disabled");

        await userEvent.keyboard("{End}s");

        await expect.element(redoButton()).toHaveAttribute("aria-disabled", "true");
        await pressDisabled(redoButton());
        expect(onUndoOrRedo).not.toHaveBeenCalled();
        expect(onCommit).not.toHaveBeenCalled();
        await expect.element(input()).toHaveFocus();
        await expect.element(input()).toHaveValue("Corner Markets");
      });

      it.each([
        ["changed back", "{Backspace}"],
        ["over", "{Escape}"],
      ])("enables Redo again once the edit is %s", async (_, keys) => {
        await render(withBar());
        await userEvent.dblClick(cellOf("Corner Market", COUNTERPARTY));
        await userEvent.keyboard("{End}s");
        await expect.element(redoButton()).toHaveAttribute("aria-disabled", "true");

        await userEvent.keyboard(keys);

        await expect.element(redoButton()).not.toHaveAttribute("aria-disabled");
      });
    });
  });

  describe("the action bar's add", () => {
    const addBelow = () => page.getByRole("button", { name: "Add row below" });
    let onAdd: Mock<(at: AddAt) => void>;
    beforeEach(() => {
      onAdd = vi.fn();
    });

    /** The table with its action bar, showing `shown`, adding with `add`. */
    const withBar = ({
      add = onAdd as ((at: AddAt) => void) | null,
      lastAdded = null as Added | null,
      shown = rows,
    } = {}) => (
      <TransactionsTable
        rows={shown}
        maxRowNumber={rows.length}
        categories={CATEGORIES}
        accounts={ACCOUNTS}
        currencies={CURRENCIES}
        onCommit={onCommit}
        lastUndoOrRedo={null}
        onUndoOrRedo={onUndoOrRedo}
        lastAdded={lastAdded}
        actionBar={{
          canUndo: false,
          canRedo: false,
          add,
          deleteRows: () => {},
          mark: () => null,
          unmark: () => {},
          render: (actions) => <ActionBar {...actions} />,
        }}
      />
    );

    it.each([
      ["Add row above", "above"],
      ["Add row below", "below"],
    ] as const)(
      "%s asks for a row %s the active cell's, for its column, keeping focus in the grid",
      async (name, side) => {
        await render(withBar());
        await makeActive("Shop 2", CATEGORY);

        await userEvent.click(page.getByRole("button", { name }));

        expect(onAdd.mock.calls).toEqual([[{ row: 2, side, column: CATEGORY }]]);
        await expect.element(grid()).toHaveFocus();
      },
    );

    it("asks for a row beside none while no cell is active, for its counterparty", async () => {
      await render(withBar());

      await userEvent.click(addBelow());

      expect(onAdd.mock.calls).toEqual([[{ row: null, side: "below", column: COUNTERPARTY }]]);
    });

    it.each(["Add row above", "Add row below"])(
      "disables %s while rows can't be added",
      async (name) => {
        await render(withBar({ add: null }));
        await makeActive("Shop 2", CATEGORY);
        const button = page.getByRole("button", { name });
        await expect.element(button).toHaveAttribute("aria-disabled", "true");

        await pressDisabled(button);

        await expect.element(grid()).toHaveFocus();
        expect(activeCell()).toBe(cellOf("Shop 2", CATEGORY).element());
      },
    );

    it("saves an edit in progress first, keeping its cell active", async () => {
      await render(withBar());
      const calls: string[] = [];
      onCommit.mockImplementation((changes) => void calls.push(JSON.stringify(changes)));
      onAdd.mockImplementation((at) => void calls.push(JSON.stringify(at)));
      await userEvent.dblClick(cellOf("Corner Market", COUNTERPARTY));
      await userEvent.keyboard("{End}s");

      await userEvent.click(addBelow());

      expect(calls).toEqual([
        JSON.stringify([
          { rowIndex: 0, field: "counterparty", patch: { counterparty: "Corner Markets" } },
        ]),
        JSON.stringify({ row: 0, side: "below", column: COUNTERPARTY }),
      ]);
      await expect.element(input()).not.toBeInTheDocument();
      expect(activeCell()).toBe(cellOf("Corner Market", COUNTERPARTY).element());
    });

    it("drops an edit in progress that can't be saved first", async () => {
      await render(withBar());
      await editAtCharacter(page.getByText("$1,234.50"), 1);
      await amountInput().fill("1.2.3");

      await userEvent.click(addBelow());

      await expect.element(amountInput()).not.toBeInTheDocument();
      expect(onCommit).not.toHaveBeenCalled();
      expect(onAdd.mock.calls).toEqual([[{ row: 0, side: "below", column: AMOUNT }]]);
    });

    it("selects the added row's cell in its column, scrolling to it", async () => {
      const screen = await render(withBar());

      await screen.rerender(withBar({ lastAdded: { id: "t500", column: AMOUNT } }));

      await expect.element(cellOf("Shop 500", AMOUNT)).toBeInViewport();
      expect(activeCell()).toBe(cellOf("Shop 500", AMOUNT).element());
    });

    it("selects the added row once it's shown", async () => {
      const added = { id: "t0", column: DATE };
      const screen = await render(withBar({ shown: rows.slice(1), lastAdded: added }));
      expect(activeCell()).toBeNull();

      await screen.rerender(withBar({ lastAdded: added }));

      expect(activeCell()).toBe(cellOf("Corner Market", DATE).element());
    });

    it("has the added row's cell active from when it's first drawn", async () => {
      const change = await renderChangeable(tableProps(rows));
      await makeActive("Shop 2", CATEGORY);
      const shown = activeWhenShown("Added");

      change(tableProps(withAdded, { lastAdded: { id: ADDED.id, column: CATEGORY } }));

      expect(await shown).toEqual({ row: "Added", column: CATEGORY });
    });

    it("selects an added row once, not again on later renders", async () => {
      const added = { id: "t3", column: DATE };
      const screen = await render(withBar({ lastAdded: added }));
      await makeActive("Shop 1", REMARKS);

      await screen.rerender(withBar({ lastAdded: added }));

      expect(activeCell()).toBe(cellOf("Shop 1", REMARKS).element());
    });
  });

  describe("the action bar's delete", () => {
    const deleteButton = () => page.getByRole("button", { name: "Delete selected rows" });
    let onDelete: Mock<(rows: number[]) => void>;
    beforeEach(() => {
      onDelete = vi.fn();
    });

    /** The table with its action bar, showing `shown`, deleting with `onDelete`. */
    const withBar = (shown = rows) => (
      <TransactionsTable
        {...tableProps(shown)}
        actionBar={{
          canUndo: false,
          canRedo: false,
          add: null,
          deleteRows: onDelete,
          mark: () => null,
          unmark: () => {},
          render: (actions) => <ActionBar {...actions} />,
        }}
      />
    );

    it("asks to delete the active cell's row, keeping focus in the grid", async () => {
      await render(withBar());
      await makeActive("Shop 2", CATEGORY);

      await userEvent.click(deleteButton());

      expect(onDelete.mock.calls).toEqual([[[2]]]);
      await expect.element(grid()).toHaveFocus();
    });

    it("asks to delete every row a range covers", async () => {
      await render(withBar());
      await makeActive("Shop 3", CATEGORY);
      await userEvent.keyboard("{Shift>}{ArrowUp}{ArrowUp}{ArrowLeft}{/Shift}");

      await userEvent.click(deleteButton());

      expect(onDelete.mock.calls).toEqual([[[1, 2, 3]]]);
    });

    it("is disabled while no cell is active", async () => {
      await render(withBar());
      await expect.element(deleteButton()).toHaveAttribute("aria-disabled", "true");

      await pressDisabled(deleteButton());

      expect(onDelete).not.toHaveBeenCalled();
    });

    it("saves an edit in progress first", async () => {
      await render(withBar());
      const calls: string[] = [];
      onCommit.mockImplementation((changes) => void calls.push(JSON.stringify(changes)));
      onDelete.mockImplementation((indexes) => void calls.push(JSON.stringify(indexes)));
      await userEvent.dblClick(cellOf("Corner Market", COUNTERPARTY));
      await userEvent.keyboard("{End}s");

      await userEvent.click(deleteButton());

      expect(calls).toEqual([
        JSON.stringify([
          { rowIndex: 0, field: "counterparty", patch: { counterparty: "Corner Markets" } },
        ]),
        JSON.stringify([0]),
      ]);
      await expect.element(input()).not.toBeInTheDocument();
    });

    it("leaves the active cell's column active on the row that takes the first one's place", async () => {
      const screen = await render(withBar());
      // From the bottom of the range up, so the active cell is in its last row.
      await makeActive("Shop 3", CATEGORY);
      await userEvent.keyboard("{Shift>}{ArrowUp}{ArrowRight}{/Shift}");

      await userEvent.click(deleteButton());
      await screen.rerender(withBar(rows.toSpliced(2, 2)));

      expect(activeCell()).toBe(cellOf("Shop 4", CATEGORY).element());
      expect(selectedCells()).toEqual([cellOf("Shop 4", CATEGORY).element()]);
    });

    it("makes the last row's cell active once the last rows are deleted", async () => {
      const shown = rows.slice(0, 5);
      const screen = await render(withBar(shown));
      await makeActive("Shop 4", AMOUNT);

      await userEvent.click(deleteButton());
      await screen.rerender(withBar(shown.slice(0, 4)));

      expect(activeCell()).toBe(cellOf("Shop 3", AMOUNT).element());
    });

    it("leaves no cell active once every row is deleted", async () => {
      const screen = await render(withBar(rows.slice(0, 1)));
      await makeActive("Corner Market", AMOUNT);

      await userEvent.click(deleteButton());
      await screen.rerender(withBar([]));

      expect(activeCell()).toBeNull();
      await expect.element(deleteButton()).toHaveAttribute("aria-disabled", "true");
    });
  });

  describe("the action bar's marking as a duplicate or a transfer", () => {
    const button = (name: string) => page.getByRole("button", { name, exact: true });
    const duplicateButton = () => button("Mark as duplicate");
    const transferButton = () => button("Mark as transfer");
    const cancelButton = (kind: MarkKind) => button(`Cancel marking as ${kind}`);
    const rowOf = (text: string) =>
      page.getByText(text, { exact: true }).element().closest('[role="row"]')!;
    const cellsOf = (text: string) => [...rowOf(text).querySelectorAll('[role="gridcell"]')];
    const markedTint = () => backgroundOfClass("bg-amber/20");
    /** The toast explaining picking for `kind`, by its title. */
    const help = (kind: MarkKind) => page.getByText(`Marking as ${kind}`, { exact: true });

    /** What confirming marked: as what, which rows, and against which. */
    let marked: { kind: MarkKind; marked: string[]; picked: string }[];
    let mark: Mock<NonNullable<TableProps["actionBar"]>["mark"]>;
    let unmark: Mock<NonNullable<TableProps["actionBar"]>["unmark"]>;
    beforeEach(() => {
      marked = [];
      // Marking against a row changes something, unless it's one of those marked.
      mark = vi.fn((kind, rows, picked) =>
        rows.includes(picked) ? null : () => void marked.push({ kind, marked: [...rows], picked }),
      );
      unmark = vi.fn();
    });

    /** The table with its action bar, showing `shown`, and `moved` as the last undo or redo. */
    const withBar = (shown = rows, moved: Moved<Edit> | null = null) => (
      <>
        {tableWithBar(shown, moved)}
        {/* Where the app has it, clear of the bar. */}
        <Toaster position="top-center" />
      </>
    );

    /** `withBar`'s table, without its toaster. */
    const tableWithBar = (shown = rows, moved: Moved<Edit> | null = null) => (
      <TransactionsTable
        {...tableProps(shown, { lastUndoOrRedo: moved })}
        actionBar={{
          canUndo: true,
          canRedo: false,
          add: () => {},
          deleteRows: () => {},
          mark,
          unmark,
          render: (actions) => <ActionBar {...actions} />,
        }}
      />
    );

    /** Renders the table with its bar, and starts marking `text`'s row as `kind`. */
    async function startMarking(kind: MarkKind, text = "Shop 2") {
      const screen = await render(withBar());
      await makeActive(text, CATEGORY);
      await userEvent.click(kind === "duplicate" ? duplicateButton() : transferButton());
      return screen;
    }

    it("is disabled while no cell is active", async () => {
      await render(withBar());

      await expect.element(duplicateButton()).toHaveAttribute("aria-disabled", "true");
      await expect.element(transferButton()).toHaveAttribute("aria-disabled", "true");
    });

    it("turns the two buttons into cancel and confirm, keeping focus in the grid", async () => {
      await startMarking("duplicate");

      await expect.element(cancelButton("duplicate")).toBeInTheDocument();
      // Confirm, named for what it marks, with no row picked to mark against yet.
      await expect.element(duplicateButton()).toHaveAttribute("aria-disabled", "true");
      await expect.element(transferButton()).not.toBeInTheDocument();
      await expect.element(grid()).toHaveFocus();
    });

    it("picks no row at first, so only the rows being marked stand out", async () => {
      await startMarking("duplicate");

      expect(selectedCells()).toEqual([]);
      expect(activeCell()).toBeNull();
      expect(rangeOutline()).toBeNull();
      expect(mark).not.toHaveBeenCalled();
    });

    it("leaves no header active, though one was last", async () => {
      await render(withBar());
      await makeActive("Corner Market", CATEGORY);
      // Up to the header, and back down.
      await userEvent.keyboard("{ArrowUp}{ArrowDown}");

      await userEvent.click(duplicateButton());

      expect(grid().element().getAttribute("aria-activedescendant")).toBeNull();
    });

    it("picks nothing when the grid's tabbed back into", async () => {
      await startMarking("duplicate");

      await userEvent.keyboard("{Tab}");
      await expect.element(grid()).not.toHaveFocus();
      await userEvent.keyboard("{Shift>}{Tab}{/Shift}");

      await expect.element(grid()).toHaveFocus();
      expect(selectedCells()).toEqual([]);
    });

    it("tints the rows being marked, across the row, until it stops", async () => {
      await render(withBar());
      await makeActive("Shop 3", CATEGORY);
      await userEvent.keyboard("{Shift>}{ArrowUp}{ArrowUp}{/Shift}");

      await userEvent.click(duplicateButton());

      const tinted = ["Shop 1", "Shop 2", "Shop 3", "Shop 4"].map(
        (text) => backgroundOf(rowOf(text)) === markedTint(),
      );
      expect(tinted).toEqual([true, true, true, false]);
      await userEvent.keyboard("{Escape}");
      expect(backgroundOf(rowOf("Shop 1"))).not.toBe(markedTint());
    });

    it("picks a row pressed, without editing it, and confirm marks against it", async () => {
      await startMarking("duplicate");

      await userEvent.dblClick(cellOf("Shop 5", COUNTERPARTY));
      await expect.element(input()).not.toBeInTheDocument();
      // As the whole row selected, with no cell in it outlined as active.
      expect(selectedCells()).toEqual(cellsOf("Shop 5"));
      expect(cellsOf("Shop 5").map((cell) => getComputedStyle(cell).outlineStyle)).toEqual(
        Array(6).fill("none"),
      );
      await userEvent.click(button("Mark as duplicate of row 6"));

      expect(marked).toEqual([{ kind: "duplicate", marked: ["t2"], picked: "t5" }]);
      await expect.element(cancelButton("duplicate")).not.toBeInTheDocument();
      expect(activeCell()).toBe(cellOf("Shop 5", COUNTERPARTY).element());
      expect(selectedCells()).toEqual([cellOf("Shop 5", COUNTERPARTY).element()]);
    });

    it("picks a row by its number", async () => {
      await startMarking("duplicate");

      await userEvent.click(page.elementLocator(numberFor("Shop 4")));

      expect(selectedCells()).toEqual(cellsOf("Shop 4"));
      await expect
        .element(button("Mark as duplicate of row 5"))
        .not.toHaveAttribute("aria-disabled");
    });

    it("shows the row picked as one, its number tinted as its cells, lined only above and below", async () => {
      await startMarking("duplicate");

      await userEvent.click(cellOf("Shop 5", DATE));

      const number = numberFor("Shop 5");
      expect(backgroundOf(number)).toBe(backgroundOfClass("bg-focus/15"));
      expect(cellsOf("Shop 5").map(backgroundOf)).toEqual(Array(6).fill(backgroundOf(number)));
      const lines = rangeOutline()!;
      const box = lines.getBoundingClientRect();
      const first = number.getBoundingClientRect();
      const last = cellOf("Shop 5", REMARKS).element().getBoundingClientRect();
      // Firefox can differ in the last digits, adding up the columns a box spans.
      expect([box.left, box.top, box.right, box.bottom]).toEqual(
        [first.left, first.top, last.right, last.bottom].map((edge) => expect.closeTo(edge, 2)),
      );
      const style = getComputedStyle(lines);
      expect([
        style.borderTopWidth,
        style.borderBottomWidth,
        style.borderLeftWidth,
        style.borderRightWidth,
        style.outlineStyle,
      ]).toEqual(["1px", "1px", "0px", "0px", "none"]);
      expect([style.borderTopColor, style.borderBottomColor]).toEqual(
        Array(2).fill(colorOfClass("text-focus")),
      );
    });

    it("moves the pick with the keys from the row being marked, with Shift too, and Enter marks against it", async () => {
      await startMarking("duplicate");

      await userEvent.keyboard("{ArrowDown}");
      expect(selectedCells()).toEqual(cellsOf("Shop 3"));
      await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
      expect(selectedCells()).toEqual(cellsOf("Shop 4"));
      await userEvent.keyboard("{Enter}");

      expect(marked).toEqual([{ kind: "duplicate", marked: ["t2"], picked: "t4" }]);
    });

    it("starts the keys from the cell that was active, of several rows being marked", async () => {
      await render(withBar());
      await makeActive("Shop 3", CATEGORY);
      await userEvent.keyboard("{Shift>}{ArrowUp}{ArrowUp}{/Shift}");
      await userEvent.click(duplicateButton());

      await userEvent.keyboard("{ArrowUp}");

      expect(selectedCells()).toEqual(cellsOf("Shop 2"));
    });

    it("picks the first row with a key, when the rows being marked aren't shown", async () => {
      const screen = await startMarking("duplicate");
      await screen.rerender(withBar(rows.slice(5, 10)));

      await userEvent.keyboard("{ArrowDown}");

      expect(selectedCells()).toEqual(cellsOf("Shop 5"));
    });

    it("doesn't mark on Enter while no row is picked, or the one picked would change nothing", async () => {
      await startMarking("duplicate");

      await userEvent.keyboard("{Enter}");
      await userEvent.click(cellOf("Shop 2", DATE));
      await userEvent.keyboard("{Enter}");

      expect(marked).toEqual([]);
      await expect.element(cancelButton("duplicate")).toBeInTheDocument();
    });

    it.each([
      ["duplicate", "Mark as duplicate of row 3"],
      ["transfer", "Mark as transfer with row 3"],
    ] as const)(
      "says what confirming a %s marks against the row picked, disabled where that would change nothing",
      async (kind, label) => {
        await startMarking(kind);

        await userEvent.click(cellOf("Shop 2", DATE));

        await expect.element(button(label)).toHaveAttribute("aria-disabled", "true");
      },
    );

    it("marks every row a range covers", async () => {
      await render(withBar());
      await makeActive("Shop 3", CATEGORY);
      await userEvent.keyboard("{Shift>}{ArrowUp}{ArrowUp}{ArrowLeft}{/Shift}");
      await userEvent.click(duplicateButton());

      await userEvent.click(cellOf("Shop 6", DATE));
      await userEvent.click(button("Mark as duplicate of row 7"));

      expect(marked).toEqual([{ kind: "duplicate", marked: ["t1", "t2", "t3"], picked: "t6" }]);
    });

    it.each([
      ["Escape", () => userEvent.keyboard("{Escape}")],
      ["Cancel", () => userEvent.click(cancelButton("duplicate"))],
    ])("%s stops without marking, back to the selection it started from", async (_, stop) => {
      await render(withBar());
      await makeActive("Shop 3", CATEGORY);
      await userEvent.keyboard("{Shift>}{ArrowUp}{ArrowLeft}{/Shift}");
      const selected = selectedCells();
      await userEvent.click(duplicateButton());
      await userEvent.click(cellOf("Shop 6", DATE));

      await stop();

      expect(marked).toEqual([]);
      await expect.element(cancelButton("duplicate")).not.toBeInTheDocument();
      expect(selectedCells()).toEqual(selected);
      expect(activeCell()).toBe(cellOf("Shop 3", CATEGORY).element());
    });

    it("goes back to the selection it started from where its rows have moved to", async () => {
      const screen = await startMarking("duplicate");
      const shown = rows.slice(0, 10).toReversed();
      await screen.rerender(withBar(shown));

      await userEvent.keyboard("{Escape}");

      expect(activeCell()).toBe(cellOf("Shop 2", CATEGORY).element());
    });

    it("starts marking a transfer from one row only", async () => {
      await render(withBar());
      await makeActive("Shop 3", CATEGORY);
      await userEvent.keyboard("{Shift>}{ArrowLeft}{/Shift}");
      await expect.element(transferButton()).not.toHaveAttribute("aria-disabled");

      await userEvent.keyboard("{Shift>}{ArrowUp}{/Shift}");
      await expect.element(transferButton()).toHaveAttribute("aria-disabled", "true");
      await pressDisabled(transferButton());

      await expect.element(cancelButton("transfer")).not.toBeInTheDocument();
    });

    it("says what confirming a transfer marks, then against which row", async () => {
      await startMarking("transfer");
      await expect.element(cancelButton("transfer")).toBeInTheDocument();
      await expect.element(transferButton()).toHaveAttribute("aria-disabled", "true");

      await userEvent.click(cellOf("Shop 3", AMOUNT));
      await userEvent.click(button("Mark as transfer with row 4"));

      expect(marked).toEqual([{ kind: "transfer", marked: ["t2"], picked: "t3" }]);
    });

    it("can't add or delete rows while picking, but can undo", async () => {
      await startMarking("duplicate");

      for (const name of ["Add row above", "Add row below", "Delete selected rows"])
        await expect.element(button(name)).toHaveAttribute("aria-disabled", "true");
      await expect.element(button("Undo")).not.toHaveAttribute("aria-disabled");
    });

    it("stops at an undo or redo, which selects what it changed", async () => {
      const screen = await startMarking("duplicate");

      await screen.rerender(
        withBar(rows, {
          direction: "undo",
          step: {
            changes: Promise.resolve(new Uint8Array()),
            about: {
              kind: "transaction",
              cells: [{ id: "t7", field: "remarks" }],
              transactions: ["t7"],
              description: "an edit",
            },
          },
        }),
      );

      await expect.element(cancelButton("duplicate")).not.toBeInTheDocument();
      expect(activeCell()).toBe(cellOf("Shop 7", REMARKS).element());
      expect(backgroundOf(rowOf("Shop 2"))).not.toBe(markedTint());
      await expect.element(help("duplicate")).not.toBeInTheDocument();
    });

    it("saves an edit in progress first", async () => {
      await render(withBar());
      await userEvent.dblClick(cellOf("Corner Market", COUNTERPARTY));
      await userEvent.keyboard("{End}s");

      await userEvent.click(duplicateButton());

      expect(onCommit.mock.calls).toEqual([
        [[{ rowIndex: 0, field: "counterparty", patch: { counterparty: "Corner Markets" } }]],
      ]);
      await expect.element(input()).not.toBeInTheDocument();
      await expect.element(cancelButton("duplicate")).toBeInTheDocument();
    });

    describe("unmarking", () => {
      // Shop 2 and Shop 3 are duplicates of Shop 1; Shop 3 and Shop 4 are transfers.
      const withMarks = () =>
        rows.map((row, index) => ({
          ...row,
          duplicate_of: index === 2 || index === 3 ? "t1" : null,
          transfer_account: index === 3 || index === 4 ? "Savings" : null,
        }));
      const unmarkButton = (kind: MarkKind) => button(`Unmark as ${kind}`);

      it("unmarks the rows selected, all marked, at once, keeping them selected", async () => {
        await render(withBar(withMarks()));
        await makeActive("Shop 3", CATEGORY);
        await userEvent.keyboard("{Shift>}{ArrowUp}{/Shift}");
        const selected = selectedCells();
        // Its icon, and the slash through it.
        expect(unmarkButton("duplicate").element().querySelectorAll("svg")).toHaveLength(2);

        await userEvent.click(unmarkButton("duplicate"));

        expect(unmark.mock.calls).toEqual([["duplicate", [2, 3]]]);
        await expect.element(cancelButton("duplicate")).not.toBeInTheDocument();
        expect(selectedCells()).toEqual(selected);
      });

      it("marks as usual when a row selected isn't marked", async () => {
        await render(withBar(withMarks()));
        // Shop 3's a duplicate, but Shop 4 isn't.
        await makeActive("Shop 4", CATEGORY);
        await userEvent.keyboard("{Shift>}{ArrowUp}{/Shift}");
        expect(duplicateButton().element().querySelectorAll("svg")).toHaveLength(1);

        await userEvent.click(duplicateButton());

        await expect.element(cancelButton("duplicate")).toBeInTheDocument();
        expect(unmark).not.toHaveBeenCalled();
      });

      it("unmarks several transfers, though it marks one at a time", async () => {
        await render(withBar(withMarks()));
        await makeActive("Shop 4", CATEGORY);
        await userEvent.keyboard("{Shift>}{ArrowUp}{/Shift}");

        await userEvent.click(unmarkButton("transfer"));

        expect(unmark.mock.calls).toEqual([["transfer", [3, 4]]]);
        // Shop 2 isn't a transfer, and a transfer is marked from one row.
        await userEvent.keyboard("{Shift>}{ArrowUp}{/Shift}");
        await expect.element(transferButton()).toHaveAttribute("aria-disabled", "true");
      });

      it("saves an edit in progress first", async () => {
        await render(withBar(withMarks()));
        await userEvent.dblClick(cellOf("Shop 2", COUNTERPARTY));
        await userEvent.keyboard("{End}s");

        await userEvent.click(unmarkButton("duplicate"));

        expect(onCommit.mock.calls).toEqual([
          [[{ rowIndex: 2, field: "counterparty", patch: { counterparty: "Shop 2s" } }]],
        ]);
        expect(unmark.mock.calls).toEqual([["duplicate", [2]]]);
        expect(onCommit.mock.invocationCallOrder[0]).toBeLessThan(
          unmark.mock.invocationCallOrder[0]!,
        );
        await expect.element(input()).not.toBeInTheDocument();
      });
    });

    describe("explaining it in a toast", () => {
      it("shows one while picking, until it stops", async () => {
        await startMarking("duplicate");

        await expect.element(help("duplicate")).toBeInTheDocument();
        await expect
          .element(page.getByText("Select the transaction that this is a duplicate of."))
          .toBeInTheDocument();
        await userEvent.keyboard("{Escape}");

        await expect.element(help("duplicate")).not.toBeInTheDocument();
      });

      it("shows one every time, once something has been marked too", async () => {
        await startMarking("duplicate");
        await userEvent.click(cellOf("Shop 5", DATE));
        await userEvent.keyboard("{Enter}");
        await expect.element(help("duplicate")).not.toBeInTheDocument();

        await userEvent.click(duplicateButton());

        await expect.element(help("duplicate")).toBeInTheDocument();
      });

      it("shows one for a transfer", async () => {
        await startMarking("transfer");

        await expect.element(help("transfer")).toBeInTheDocument();
        await expect
          .element(page.getByText("Pick the transaction from the other side of the transfer."))
          .toBeInTheDocument();
      });

      it("cancels when it's closed, back to the selection it started from", async () => {
        await render(withBar());
        await makeActive("Shop 3", CATEGORY);
        await userEvent.keyboard("{Shift>}{ArrowUp}{ArrowLeft}{/Shift}");
        const selected = selectedCells();
        await userEvent.click(duplicateButton());
        await userEvent.click(cellOf("Shop 6", DATE));

        const close = page.getByRole("button", { name: "Close toast" });
        // The pointer coming over the toasts can move them (sonner expands
        // them), so it's over them first: the click then waits till they're still.
        await userEvent.hover(close);
        await userEvent.click(close);

        await expect.element(cancelButton("duplicate")).not.toBeInTheDocument();
        expect(marked).toEqual([]);
        expect(selectedCells()).toEqual(selected);
        await expect.element(help("duplicate")).not.toBeInTheDocument();
      });

      it("goes while the page is hidden, which doesn't cancel, and comes back with it", async () => {
        // The toaster is outside the pages, as the app has it.
        const app = (mode: "visible" | "hidden") => (
          <>
            <Activity mode={mode}>{tableWithBar()}</Activity>
            <Toaster position="top-center" />
          </>
        );
        const screen = await render(app("visible"));
        await makeActive("Shop 2", CATEGORY);
        await userEvent.click(duplicateButton());
        await expect.element(help("duplicate")).toBeInTheDocument();

        await screen.rerender(app("hidden"));
        await expect.element(help("duplicate")).not.toBeInTheDocument();
        // Sonner says it was dismissed a frame or so later.
        await new Promise((resolve) => setTimeout(resolve, 200));
        await screen.rerender(app("visible"));

        await expect.element(cancelButton("duplicate")).toBeInTheDocument();
        await expect.element(help("duplicate")).toBeInTheDocument();
      });
    });
  });

  describe("the action bar's search", () => {
    const searchField = () => page.getByRole("searchbox", { name: "Search transactions" });
    const regexButton = () => page.getByRole("button", { name: "Use regular expression" });
    /** What's highlighted in a cell, in order. */
    const marksIn = (cell: Locator) =>
      [...cell.element().querySelectorAll("mark")].map((mark) => mark.textContent);
    /** What's highlighted anywhere in the grid. */
    const allMarks = () => [...grid().element().querySelectorAll("mark")];
    /**
     * The cell in `column` of the row at `row`. (Not found by its text: what's
     * highlighted in another cell can be that text too.)
     */
    const cellAt = (row: number, column: number) =>
      page.elementLocator(
        cellIn(document.querySelector(`[role="row"][aria-rowindex="${row + 2}"]`)!, column),
      );

    const barProps = (shown = rows): TableProps =>
      tableProps(shown, {
        actionBar: {
          canUndo: false,
          canRedo: false,
          add: null,
          deleteRows: () => {},
          mark: () => null,
          unmark: () => {},
          render: (actions) => <ActionBar {...actions} />,
        },
      });

    async function search(text: string) {
      await render(<TransactionsTable {...barProps()} />);
      await userEvent.fill(searchField(), text);
    }

    it("highlights what it finds in each cell, ignoring case", async () => {
      await search("shop 1");

      expect(marksIn(cellAt(1, COUNTERPARTY))).toEqual(["Shop 1"]);
      expect(marksIn(cellAt(12, COUNTERPARTY))).toEqual(["Shop 1"]);
      expect(marksIn(cellAt(2, COUNTERPARTY))).toEqual([]);
      expect(marksIn(cellAt(1, CATEGORY))).toEqual([]);
    });

    it("highlights every match in a cell", async () => {
      await search("1");

      expect(marksIn(cellAt(11, COUNTERPARTY))).toEqual(["1", "1"]);
    });

    it("finds amounts as they're shown", async () => {
      await search("1,234");

      expect(marksIn(cellAt(0, AMOUNT))).toEqual(["1,234"]);
    });

    it("leaves the text as it was around what it highlights", async () => {
      await search("market");

      await expect.element(cellAt(0, COUNTERPARTY)).toHaveTextContent("Corner Market");
    });

    it("highlights nothing once the search is cleared", async () => {
      await search("shop");
      expect(allMarks()).not.toHaveLength(0);

      await userEvent.clear(searchField());

      expect(allMarks()).toHaveLength(0);
    });

    it("doesn't highlight the cell being edited", async () => {
      await search("corner");
      await userEvent.dblClick(cellAt(0, COUNTERPARTY));
      await expect.element(input()).toHaveValue("Corner Market");

      expect(input().element().closest('[role="gridcell"]')!.querySelector("mark")).toBeNull();
      expect(marksIn(cellAt(0, COUNTERPARTY))).toEqual([]);
    });

    it("edits a highlighted cell from where it's pressed, highlight and all", async () => {
      // Which selects the cell it's found in: pressing it again edits it.
      await search("market");
      const text = page.getByText("Corner Market", { exact: true });
      const mark = text.element().querySelector("mark")!;
      // The "r" of "Market", inside the highlight.
      const range = document.createRange();
      range.setStart(mark.firstChild!, 2);
      range.setEnd(mark.firstChild!, 3);
      const char = range.getBoundingClientRect();
      const box = text.element().getBoundingClientRect();

      await userEvent.click(text, {
        position: { x: char.left + 1 - box.left, y: box.height / 2 },
      });

      expect(textSelection()).toEqual([9, 9]);
    });

    it("highlights what it finds once a change to the rows has it", async () => {
      const change = await renderChangeable(barProps());
      await userEvent.fill(searchField(), "café");
      expect(allMarks()).toHaveLength(0);

      change(barProps(rows.with(1, { ...rows[1]!, counterparty: "Café Lumen" })));

      await expect.poll(() => marksIn(cellAt(1, COUNTERPARTY))).toEqual(["Café"]);
    });

    describe("going from one cell found to the next", () => {
      const previousButton = () => page.getByRole("button", { name: "Previous match" });
      const nextButton = () => page.getByRole("button", { name: "Next match" });
      /** How many cells it's found in, as the field says. */
      const count = () => page.getByRole("status");
      /** The active cell, as its row's index and its column. */
      function active() {
        const cell = activeCell();
        const row = cell?.closest('[role="row"]');
        if (!cell || !row) return null;
        return {
          row: Number(row.getAttribute("aria-rowindex")) - 2,
          column: [...row.querySelectorAll('[role="gridcell"]')].indexOf(cell),
        };
      }

      /** Renders the table with its bar, showing `shown`, and makes a cell active. */
      async function renderActive(row: number, column: number, shown = rows) {
        await render(<TransactionsTable {...barProps(shown)} />);
        await makeActive(rows[row]!.counterparty, column);
      }

      it("selects the first cell found from the active one on, as it's typed", async () => {
        await renderActive(5, COUNTERPARTY);

        await userEvent.fill(searchField(), "shop 1");

        expect(active()).toEqual({ row: 10, column: COUNTERPARTY });
        await expect.element(searchField()).toHaveFocus();
      });

      it("stays on the active cell while it's still found there, typing on", async () => {
        await renderActive(5, COUNTERPARTY);
        await userEvent.click(searchField());

        await userEvent.keyboard("sho");
        expect(active()).toEqual({ row: 5, column: COUNTERPARTY });
        await userEvent.keyboard("p 1");
        expect(active()).toEqual({ row: 10, column: COUNTERPARTY });
        await userEvent.keyboard("2");
        expect(active()).toEqual({ row: 12, column: COUNTERPARTY });
        await userEvent.keyboard("{Backspace}");

        expect(active()).toEqual({ row: 12, column: COUNTERPARTY });
      });

      it("selects the first cell found with none active", async () => {
        await search("shop");

        expect(active()).toEqual({ row: 1, column: COUNTERPARTY });
      });

      it("collapses a range to the cell found", async () => {
        await renderActive(2, COUNTERPARTY);
        await userEvent.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}");

        await userEvent.fill(searchField(), "shop 7");

        expect(selectedCells()).toEqual([activeCell()]);
        expect(active()).toEqual({ row: 7, column: COUNTERPARTY });
      });

      it("scrolls to a cell found further down", async () => {
        await search("shop 5000");

        expect(active()).toEqual({ row: 5000, column: COUNTERPARTY });
        // The row's box: a cell's goes on over the line below it.
        const box = activeCell()!.closest('[role="row"]')!.getBoundingClientRect();
        expect(box.top).toBeGreaterThanOrEqual(0);
        expect(box.bottom).toBeLessThanOrEqual(window.innerHeight);
      });

      it("leaves the selection as it was when nothing's found", async () => {
        await renderActive(5, CATEGORY);

        await userEvent.fill(searchField(), "zzz");

        expect(active()).toEqual({ row: 5, column: CATEGORY });
        await expect.element(count()).toHaveTextContent("No matches");
      });

      it("goes on to the next cell found, and back, with the arrows", async () => {
        await search("shop 1");

        await userEvent.click(nextButton());
        expect(active()).toEqual({ row: 10, column: COUNTERPARTY });
        await userEvent.click(nextButton());
        expect(active()).toEqual({ row: 11, column: COUNTERPARTY });
        await userEvent.click(previousButton());

        expect(active()).toEqual({ row: 10, column: COUNTERPARTY });
        await expect.element(searchField()).toHaveFocus();
      });

      it("goes on with Enter, and back with Shift+Enter, in the field", async () => {
        await search("shop 1");

        await userEvent.keyboard("{Enter}");
        expect(active()).toEqual({ row: 10, column: COUNTERPARTY });
        await userEvent.keyboard("{Shift>}{Enter}{/Shift}");

        expect(active()).toEqual({ row: 1, column: COUNTERPARTY });
        await expect.element(searchField()).toHaveFocus();
      });

      it("goes round from the last cell found to the first, and back", async () => {
        await renderActive(19, COUNTERPARTY, rows.slice(0, 20));
        await userEvent.fill(searchField(), "shop 1");

        await userEvent.click(nextButton());
        expect(active()).toEqual({ row: 1, column: COUNTERPARTY });
        await userEvent.click(previousButton());

        expect(active()).toEqual({ row: 19, column: COUNTERPARTY });
      });

      it("goes on from a cell it isn't found in", async () => {
        await search("shop 1");
        await makeActive("Shop 5", CATEGORY);

        await userEvent.click(nextButton());

        expect(active()).toEqual({ row: 10, column: COUNTERPARTY });
      });

      it("disables the arrows while there's nothing to go to", async () => {
        await render(<TransactionsTable {...barProps()} />);
        await expect.element(previousButton()).toHaveAttribute("aria-disabled", "true");
        await expect.element(nextButton()).toHaveAttribute("aria-disabled", "true");

        await userEvent.fill(searchField(), "zzz");
        await expect.element(nextButton()).toHaveAttribute("aria-disabled", "true");
        await pressDisabled(nextButton());
        expect(activeCell()).toBeNull();

        await userEvent.fill(searchField(), "shop");
        await expect.element(previousButton()).not.toHaveAttribute("aria-disabled");
        await expect.element(nextButton()).not.toHaveAttribute("aria-disabled");
      });

      it("disables the arrows while the regular expression can't be one", async () => {
        await search("shop");
        await userEvent.click(regexButton());

        await userEvent.fill(searchField(), "shop (");

        await expect.element(nextButton()).toHaveAttribute("aria-disabled", "true");
        await expect.element(previousButton()).toHaveAttribute("aria-disabled", "true");
      });

      describe("counting", () => {
        it("says which of the cells found the active one is", async () => {
          await renderActive(5, COUNTERPARTY, rows.slice(0, 20));

          await userEvent.fill(searchField(), "shop 1");

          // Shop 1, then Shop 10 to Shop 19.
          await expect.element(count()).toHaveTextContent("2 of 11");
          await userEvent.click(nextButton());
          await expect.element(count()).toHaveTextContent("3 of 11");
        });

        it("only says how many while the active cell isn't one of them", async () => {
          await renderActive(5, COUNTERPARTY, rows.slice(0, 20));
          await userEvent.fill(searchField(), "shop 1");

          await makeActive("Shop 12", CATEGORY);

          await expect.poll(() => count().element().textContent).toBe("11");
        });

        it("groups the digits of a large count", async () => {
          await search("shop");

          await expect.element(count()).toHaveTextContent("1 of 99,999");
        });

        it("counts again once the rows change", async () => {
          const change = await renderChangeable(barProps(rows.slice(0, 20)));
          await userEvent.fill(searchField(), "shop 1");
          await expect.element(count()).toHaveTextContent("1 of 11");

          change(barProps(rows.slice(0, 12)));

          await expect.element(count()).toHaveTextContent("1 of 3");
        });

        it("says nothing without text, or for a regular expression that can't be one", async () => {
          await render(<TransactionsTable {...barProps()} />);
          await expect.element(count()).not.toBeInTheDocument();

          await userEvent.click(regexButton());
          await userEvent.fill(searchField(), "(");

          await expect.element(count()).not.toBeInTheDocument();
        });
      });

      it("clears the search with Escape, keeping the cell found selected", async () => {
        await search("shop 1");

        await userEvent.keyboard("{Escape}");

        await expect.element(searchField()).toHaveValue("");
        expect(allMarks()).toHaveLength(0);
        await expect.element(count()).not.toBeInTheDocument();
        expect(active()).toEqual({ row: 1, column: COUNTERPARTY });
      });

      it("saves an edit before going on from it", async () => {
        await search("shop 1");
        await userEvent.dblClick(cellAt(12, REMARKS));
        await userEvent.keyboard("note");

        await userEvent.click(nextButton());

        expect(onCommit.mock.calls).toEqual([
          [[{ rowIndex: 12, field: "remarks", patch: { remarks: "note" } }]],
        ]);
        expect(active()).toEqual({ row: 13, column: COUNTERPARTY });
      });

      it("saves an edit left for the field, then goes to what's typed there", async () => {
        await render(<TransactionsTable {...barProps()} />);
        await userEvent.dblClick(cellAt(3, REMARKS));
        await userEvent.keyboard("note");

        await userEvent.click(searchField());
        await userEvent.keyboard("shop 1");

        expect(onCommit.mock.calls).toEqual([
          [[{ rowIndex: 3, field: "remarks", patch: { remarks: "note" } }]],
        ]);
        expect(active()).toEqual({ row: 10, column: COUNTERPARTY });
      });

      it("picks the row of the cell found while marking", async () => {
        await render(
          <TransactionsTable
            {...barProps()}
            actionBar={{ ...barProps().actionBar!, mark: () => () => {} }}
          />,
        );
        await makeActive("Shop 2", CATEGORY);
        await userEvent.click(page.getByRole("button", { name: "Mark as duplicate" }));

        await userEvent.fill(searchField(), "shop 7");

        await expect
          .element(page.getByRole("button", { name: "Mark as duplicate of row 8" }))
          .not.toHaveAttribute("aria-disabled");
      });
    });

    describe("matching case", () => {
      const matchCaseButton = () => page.getByRole("button", { name: "Match case" });

      it("is off at first, ignoring case", async () => {
        await search("SHOP 1");

        await expect.element(matchCaseButton()).toHaveAttribute("aria-pressed", "false");
        expect(marksIn(cellAt(1, COUNTERPARTY))).toEqual(["Shop 1"]);
      });

      it("finds only the case typed once on", async () => {
        await search("shop 1");

        await userEvent.click(matchCaseButton());

        await expect.element(matchCaseButton()).toHaveAttribute("aria-pressed", "true");
        expect(allMarks()).toHaveLength(0);
        await userEvent.fill(searchField(), "Shop 1");
        expect(marksIn(cellAt(1, COUNTERPARTY))).toEqual(["Shop 1"]);
      });

      it("matches the case of a regular expression too", async () => {
        await search("^S.*1$");
        await userEvent.click(regexButton());
        expect(marksIn(cellAt(1, COUNTERPARTY))).toEqual(["Shop 1"]);

        await userEvent.click(matchCaseButton());
        expect(marksIn(cellAt(1, COUNTERPARTY))).toEqual(["Shop 1"]);
        await userEvent.fill(searchField(), "^s.*1$");

        expect(allMarks()).toHaveLength(0);
      });

      it("keeps focus in the field when it's toggled", async () => {
        await search("shop");

        await userEvent.click(matchCaseButton());

        await expect.element(searchField()).toHaveFocus();
      });

      it("is toggled from anywhere across the field's height, beside the square it shows", async () => {
        await search("shop");
        const field = searchField().element().closest("search")!.getBoundingClientRect();
        const box = matchCaseButton().element().getBoundingClientRect();
        const square = matchCaseButton().element().firstElementChild!.getBoundingClientRect();
        expect([box.top, box.bottom]).toEqual([field.top, field.bottom]);
        expect([square.left - box.left, box.right - square.right]).toEqual([1, 1]);

        // In its corner, outside the square.
        await userEvent.click(matchCaseButton(), { position: { x: 0.5, y: 1 } });

        await expect.element(matchCaseButton()).toHaveAttribute("aria-pressed", "true");
      });
    });

    describe("by a regular expression", () => {
      it("is off at first, taking the text as it is", async () => {
        await search("^shop 1\\d$");

        await expect.element(regexButton()).toHaveAttribute("aria-pressed", "false");
        expect(allMarks()).toHaveLength(0);
      });

      it("searches by the text as a regular expression once on", async () => {
        await search("^shop 1\\d$");

        await userEvent.click(regexButton());

        await expect.element(regexButton()).toHaveAttribute("aria-pressed", "true");
        expect(marksIn(cellAt(12, COUNTERPARTY))).toEqual(["Shop 12"]);
        expect(marksIn(cellAt(1, COUNTERPARTY))).toEqual([]);
      });

      it("keeps focus in the field when it's toggled", async () => {
        await search("shop");

        await userEvent.click(regexButton());

        await expect.element(searchField()).toHaveFocus();
      });

      it("says the text can't be a regular expression, outlining the field red and highlighting nothing", async () => {
        await search("shop");
        await userEvent.click(regexButton());
        expect(allMarks()).not.toHaveLength(0);

        await userEvent.fill(searchField(), "shop (");

        await expect.element(searchField()).toHaveAttribute("aria-invalid", "true");
        await expect.element(searchField()).toHaveAccessibleErrorMessage("Invalid regex");
        const field = searchField().element().closest("search")!;
        expect(getComputedStyle(field).outlineColor).toBe(colorOfClass("text-danger"));
        expect(allMarks()).toHaveLength(0);
      });

      it("takes the same text as it is again once off", async () => {
        await search("shop (");
        await userEvent.click(regexButton());

        await userEvent.click(regexButton());

        await expect.element(searchField()).not.toHaveAttribute("aria-invalid");
        await expect.element(page.getByText("Invalid regex")).not.toBeInTheDocument();
      });
    });
  });

  describe("when the rows change", () => {
    it("keeps the active cell on a row that's still there", async () => {
      const screen = await render(table());
      await makeActive("Shop 3", COUNTERPARTY);

      await screen.rerender(
        <TransactionsTable
          rows={rows.slice(0, 2)}
          maxRowNumber={2}
          categories={CATEGORIES}
          accounts={ACCOUNTS}
          currencies={CURRENCIES}
          onCommit={onCommit}
          lastUndoOrRedo={null}
          onUndoOrRedo={onUndoOrRedo}
        />,
      );

      expect(activeCell()?.textContent).toBe("Shop 1");
      await userEvent.keyboard("{ArrowUp}");
      expect(activeCell()?.textContent).toBe("Corner Market");
    });
  });

  describe("reporting edits", () => {
    it("says when a cell starts and stops being edited", async () => {
      const onEditingChange = vi.fn();
      const screen = await render(
        <TransactionsTable
          rows={rows}
          maxRowNumber={rows.length}
          categories={CATEGORIES}
          accounts={ACCOUNTS}
          currencies={CURRENCIES}
          onCommit={onCommit}
          lastUndoOrRedo={null}
          onUndoOrRedo={onUndoOrRedo}
          onEditingChange={onEditingChange}
        />,
      );

      await userEvent.dblClick(cellOf("Corner Market", COUNTERPARTY));
      expect(onEditingChange.mock.calls).toEqual([[true]]);
      await userEvent.keyboard("{Escape}");
      expect(onEditingChange.mock.calls).toEqual([[true], [false]]);
      await userEvent.dblClick(cellOf("Shop 1", COUNTERPARTY));
      screen.unmount();
      expect(onEditingChange.mock.calls).toEqual([[true], [false], [true], [false]]);
    });
  });

  describe("cursor", () => {
    it("shows the default cursor over idle and active cells", async () => {
      await activate("Corner Market", COUNTERPARTY);

      expect(getComputedStyle(page.getByText("Corner Market").element()).cursor).toBe("default");
      expect(getComputedStyle(page.getByText("Shop 1", { exact: true }).element()).cursor).toBe(
        "default",
      );
      expect(getComputedStyle(cellOf("Corner Market", ACCOUNT).element()).cursor).toBe("default");
    });

    it("shows the text cursor over the edited cell", async () => {
      await renderTable();

      await userEvent.dblClick(cellOf("Corner Market", COUNTERPARTY));

      expect(getComputedStyle(input().element()).cursor).toBe("text");
    });
  });

  describe("dragging", () => {
    it("selects a range from the pressed cell to the one released over, ending the edit", async () => {
      await renderTable();

      await mouse.down(pointIn(cellOf("Corner Market", COUNTERPARTY).element()));
      await mouse.move(pointIn(cellOf("Shop 1", CATEGORY).element()));
      await mouse.move(pointIn(cellOf("Shop 2", CATEGORY).element()));
      await mouse.up(pointIn(cellOf("Shop 2", CATEGORY).element()));

      expect(selectedCells()).toHaveLength(6);
      expect(activeCell()).toBe(cellOf("Corner Market", COUNTERPARTY).element());
      await expect.element(input()).not.toBeInTheDocument();
      await expect.element(grid()).toHaveFocus();
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("saves what was typed when a drag from the edited cell selects a range", async () => {
      await renderTable();
      await editAtCharacter(page.getByText("Corner Market"), 0);
      await input().fill("Corner Shop");

      await mouse.down(pointIn(input().element()));
      await mouse.move(pointIn(cellOf("Shop 1", COUNTERPARTY).element()));
      await mouse.up(pointIn(cellOf("Shop 1", COUNTERPARTY).element()));

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "counterparty", patch: { counterparty: "Corner Shop" } },
      ]);
      expect(selectedCells()).toHaveLength(2);
      await expect.element(input()).not.toBeInTheDocument();
    });

    it("selects text while the drag stays in the cell", async () => {
      await activate("Corner Market", COUNTERPARTY);
      const text = page.getByText("Corner Market");
      const from = characterPoint(text, 0);
      const to = characterPoint(text, 6);

      await mouse.down(from);
      await mouse.move(to);
      await mouse.up(to);

      await expect.element(input()).toHaveFocus();
      expect(textSelection()).toEqual([0, 6]);
      expect(selectedCells()).toHaveLength(1);
    });

    it("selects text backwards", async () => {
      await activate("Corner Market", COUNTERPARTY);
      const text = page.getByText("Corner Market");
      const from = characterPoint(text, 6);
      const to = characterPoint(text, 2);

      await mouse.down(from);
      await mouse.move(to);
      await mouse.up(to);

      expect(textSelection()).toEqual([2, 6]);
      expect((input().element() as HTMLInputElement).selectionDirection).toBe("backward");
    });

    it("goes back to selecting text from where it started when the drag comes back", async () => {
      await activate("Corner Market", COUNTERPARTY);
      const text = page.getByText("Corner Market");
      const from = characterPoint(text, 2);
      const back = characterPoint(text, 8);
      const below = pointIn(cellOf("Shop 1", COUNTERPARTY).element());

      await mouse.down(from);
      await mouse.move(below);
      await expect.poll(() => selectedCells().length).toBe(2);
      await mouse.move(back);
      await mouse.up(back);

      await expect.element(input()).toHaveFocus();
      expect(textSelection()).toEqual([2, 8]);
      expect(selectedCells()).toHaveLength(1);
    });

    it("keeps selecting text when the drag goes past the table's last column", async () => {
      await renderTable();
      const remarks = cellOf("Corner Market", REMARKS).element();
      const box = remarks.getBoundingClientRect();
      const past = { x: box.right + 50, y: box.top + box.height / 2 };

      await mouse.down(pointIn(remarks));
      await mouse.move(past);
      await mouse.up(past);

      await expect.element(input()).toHaveFocus();
      expect(selectedCells()).toHaveLength(1);
    });

    it("hides the menu while the drag selects other cells, and shows it again when it comes back", async () => {
      await activate("Corner Market", ACCOUNT);
      const account = cellOf("Corner Market", ACCOUNT).element();

      await mouse.down(pointIn(account));
      await expect.element(page.getByRole("listbox")).toBeVisible();
      await mouse.move(pointIn(cellOf("Shop 1", ACCOUNT).element()));
      await expect.element(page.getByRole("listbox")).not.toBeInTheDocument();
      await mouse.move(pointIn(account));
      await expect.element(page.getByRole("listbox")).toBeVisible();
      await mouse.up(pointIn(account));

      await expect.element(combobox()).toHaveFocus();
    });

    it("doesn't change the highlighted option when the drag passes over the menu", async () => {
      await activate("Corner Market", CATEGORY);
      const category = cellOf("Corner Market", CATEGORY).element();

      await mouse.down(pointIn(category));
      await expect.element(highlighted()).toHaveTextContent("Groceries");
      await mouse.move(pointIn(page.getByRole("option", { name: "Dining out" }).element()));
      await mouse.move(pointIn(category));
      await mouse.up(pointIn(category));

      await expect.element(highlighted()).toHaveTextContent("Groceries");
      await userEvent.keyboard("{Enter}");
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("doesn't change the category when the drag passes over the menu on its way to other cells", async () => {
      await activate("Corner Market", CATEGORY);
      const category = cellOf("Corner Market", CATEGORY).element();
      const end = pointIn(cellOf("Shop 5", CATEGORY).element());

      await mouse.down(pointIn(category));
      await mouse.move(pointIn(page.getByRole("option", { name: "Dining out" }).element()));
      await mouse.move(end);
      await mouse.up(end);

      expect(selectedCells()).toHaveLength(6);
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("ends the drag when the mouse moves with the button no longer held", async () => {
      await renderTable();
      const end = pointIn(cellOf("Shop 1", COUNTERPARTY).element());
      const later = pointIn(cellOf("Shop 3", COUNTERPARTY).element());

      await mouse.down(pointIn(cellOf("Corner Market", COUNTERPARTY).element()));
      await mouse.move(end);
      await expect.poll(() => selectedCells().length).toBe(2);
      // The release happened where the page couldn't see it, as when
      // switching windows mid-drag.
      document.dispatchEvent(
        new MouseEvent("mousemove", { clientX: later.x, clientY: later.y, buttons: 0 }),
      );

      expect(selectedCells()).toHaveLength(2);
      await expect.element(grid()).toHaveFocus();
      await mouse.up(later);
      expect(selectedCells()).toHaveLength(2);
    });

    it("stops scrolling the page when the window loses focus mid-drag", async () => {
      await renderTable();
      const start = pointIn(cellOf("Shop 5", COUNTERPARTY).element());
      const edge = { x: start.x, y: window.innerHeight - 2 };

      await mouse.down(start);
      await mouse.move(edge);
      await expect.poll(() => window.scrollY).toBeGreaterThan(0);
      window.dispatchEvent(new FocusEvent("blur"));
      const stopped = window.scrollY;
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(window.scrollY).toBe(stopped);
      await mouse.up(edge);
    });

    it("extends the range from the active cell with Shift+click", async () => {
      await activate("Corner Market", COUNTERPARTY);

      await userEvent.click(cellOf("Shop 2", CATEGORY), { modifiers: ["Shift"] });

      expect(selectedCells()).toHaveLength(6);
      expect(activeCell()).toBe(cellOf("Corner Market", COUNTERPARTY).element());
      await expect.element(input()).not.toBeInTheDocument();
    });

    it("extends the text selection with Shift+click in the edited cell", async () => {
      await activate("Corner Market", COUNTERPARTY);
      const text = page.getByText("Corner Market");
      const from = characterPoint(text, 2);
      const to = characterPoint(text, 9);
      await mouse.down(from);
      await mouse.up(from);

      await userEvent.keyboard("{Shift>}");
      await mouse.down(to);
      await mouse.up(to);
      await userEvent.keyboard("{/Shift}");

      expect(textSelection()).toEqual([2, 9]);
      expect(selectedCells()).toHaveLength(1);
    });

    it("selects a word on double-click in the edited cell", async () => {
      await activate("Corner Market", COUNTERPARTY);
      // Where the text is, before the input takes its place.
      const point = characterPoint(page.getByText("Corner Market"), 9);
      await userEvent.keyboard("{F2}");
      const box = input().element().getBoundingClientRect();

      await userEvent.dblClick(input(), {
        position: { x: point.x - box.left, y: point.y - box.top },
      });

      expect(textSelection()).toEqual([7, 13]);
    });

    it("selects everything on triple-click", async () => {
      await renderTable();

      await userEvent.tripleClick(page.getByText("Corner Market"));

      expect(textSelection()).toEqual([0, "Corner Market".length]);
    });

    it("scrolls the page while the drag is held at the bottom of the window", async () => {
      await renderTable();
      const start = pointIn(cellOf("Shop 5", COUNTERPARTY).element());
      const edge = { x: start.x, y: window.innerHeight - 2 };

      await mouse.down(start);
      await mouse.move(edge);
      // It scrolls a little each animation frame, which a busy machine slows down.
      await expect.poll(() => window.scrollY, { timeout: 5000 }).toBeGreaterThan(ROW_HEIGHT * 10);
      await mouse.up(edge);

      expect(selectedCells().length).toBeGreaterThan(10);
      expect(activeCell()?.textContent).toBe("Shop 5");
    });

    it("extends the range when the page scrolls under the held mouse", async () => {
      await renderTable();
      const point = pointIn(cellOf("Shop 2", COUNTERPARTY).element());
      await mouse.down(pointIn(cellOf("Corner Market", COUNTERPARTY).element()));
      await mouse.move(point);
      await expect.poll(() => selectedCells().length).toBe(3);

      // As the mouse wheel would, with the mouse still.
      window.scrollBy(0, ROW_HEIGHT * 3);

      await expect.poll(() => selectedCells().length).toBe(6);
      await mouse.up(point);
      expect(activeCell()?.textContent).toBe("Corner Market");
    });

    it("doesn't scroll the page for a press near the bottom of the window", async () => {
      await renderTable();
      const lastVisible = [...renderedRows()]
        .filter((row) => row.getBoundingClientRect().bottom <= window.innerHeight)
        .at(-1)!;
      const box = cellIn(lastVisible, COUNTERPARTY).getBoundingClientRect();
      const point = { x: box.left + 5, y: box.bottom - 2 };

      await mouse.down(point);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await mouse.up(point);

      expect(window.scrollY).toBe(0);
    });
  });

  describe("combobox", () => {
    it("opens a menu of every option, with the current one highlighted", async () => {
      await renderTable();

      await userEvent.dblClick(cellOf("Corner Market", ACCOUNT));

      await expect.element(combobox()).toHaveFocus();
      await expect.element(combobox()).toHaveAttribute("aria-expanded", "true");
      expect(options()).toEqual(ACCOUNTS);
      await expect.element(highlighted()).toHaveTextContent("Everyday Checking");
      expect(combobox().element().getAttribute("aria-activedescendant")).toBe(
        highlighted().element().id,
      );
    });

    it("filters the options as the user types, ignoring case", async () => {
      await renderTable();
      await userEvent.dblClick(cellOf("Corner Market", ACCOUNT));

      await combobox().fill("CARD");

      expect(options()).toEqual(["Rewards Credit Card"]);
      await expect.element(highlighted()).toHaveTextContent("Rewards Credit Card");
    });

    it("picks the highlighted option on Enter", async () => {
      await renderTable();
      await userEvent.dblClick(cellOf("Corner Market", ACCOUNT));

      await combobox().fill("sav");
      await userEvent.keyboard("{Enter}");

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "account_name", patch: { account_name: "Savings" } },
      ]);
      await expect.element(combobox()).not.toBeInTheDocument();
      expect(activeCell()).toBe(cellOf("Shop 1", ACCOUNT).element());
    });

    it("keeps the cell active when an option is picked with the mouse", async () => {
      await renderTable();
      await userEvent.dblClick(cellOf("Corner Market", ACCOUNT));

      await userEvent.click(page.getByRole("option", { name: "Savings" }));

      await expect.element(combobox()).not.toBeInTheDocument();
      expect(activeCell()).toBe(cellOf("Corner Market", ACCOUNT).element());
    });

    it("moves the highlight with the arrow keys", async () => {
      await renderTable();
      await userEvent.dblClick(cellOf("Corner Market", ACCOUNT));

      await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowUp}");

      await expect.element(highlighted()).toHaveTextContent("Rewards Credit Card");
      await userEvent.keyboard("{Enter}");
      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "account_name", patch: { account_name: "Rewards Credit Card" } },
      ]);
    });

    it("picks an option with the mouse", async () => {
      await renderTable();
      await userEvent.dblClick(cellOf("Corner Market", ACCOUNT));

      await userEvent.click(page.getByRole("option", { name: "Savings" }));

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "account_name", patch: { account_name: "Savings" } },
      ]);
      await expect.element(combobox()).not.toBeInTheDocument();
    });

    it("says when no account matches, and doesn't save on Enter", async () => {
      await renderTable();
      await userEvent.dblClick(cellOf("Corner Market", ACCOUNT));

      await combobox().fill("fdsafjsdoif");
      await userEvent.keyboard("{Enter}");

      await expect.element(page.getByText("No account found")).toBeVisible();
      await expect.element(combobox()).toHaveAttribute("aria-expanded", "false");
      await expect.element(combobox()).toHaveFocus();
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("saves an exact match when leaving the cell, in the option's own case", async () => {
      await renderTable();
      await userEvent.dblClick(cellOf("Corner Market", ACCOUNT));

      await combobox().fill("savings");
      combobox().element().blur();

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "account_name", patch: { account_name: "Savings" } },
      ]);
    });

    it("saves the highlighted account when leaving the cell", async () => {
      await renderTable();
      await userEvent.dblClick(cellOf("Corner Market", ACCOUNT));

      await combobox().fill("Sav");
      combobox().element().blur();

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "account_name", patch: { account_name: "Savings" } },
      ]);
    });

    it("saves an option picked with the arrow keys when leaving the cell", async () => {
      await renderTable();
      await userEvent.dblClick(cellOf("Corner Market", ACCOUNT));

      await userEvent.keyboard("{ArrowDown}");
      combobox().element().blur();

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "account_name", patch: { account_name: "Rewards Credit Card" } },
      ]);
    });

    it("undoes an account that names no option when leaving the cell", async () => {
      await renderTable();
      await userEvent.dblClick(cellOf("Corner Market", ACCOUNT));

      await combobox().fill("fdsafjsdoif");
      combobox().element().blur();

      await expect
        .element(page.getByText("There's no account named “fdsafjsdoif”. The change was undone."))
        .toBeVisible();
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("saves the highlighted existing category when leaving the cell", async () => {
      await renderTable();
      await userEvent.dblClick(cellOf("Shop 1", CATEGORY));

      await combobox().fill("gro");
      combobox().element().blur();

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 1, field: "category", patch: { category: "Groceries" } },
      ]);
    });

    it("doesn't create a category highlighted with the arrow keys when leaving the cell", async () => {
      await renderTable();
      await userEvent.dblClick(cellOf("Shop 1", CATEGORY));

      await combobox().fill("gro");
      await userEvent.keyboard("{ArrowDown}");
      await expect.element(highlighted()).toHaveTextContent("Create category “gro”");
      combobox().element().blur();

      await expect
        .element(page.getByText("There's no category named “gro”. The change was undone."))
        .toBeVisible();
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("offers to create a category that doesn't exist", async () => {
      await renderTable();
      await userEvent.dblClick(cellOf("Corner Market", CATEGORY));

      await combobox().fill("Pets");

      expect(options()).toEqual(["Create category “Pets”"]);
      await userEvent.keyboard("{Enter}");
      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "category", patch: { category: "Pets" } },
      ]);
    });

    it("picks the first matching category over creating one", async () => {
      await renderTable();
      await userEvent.dblClick(cellOf("Shop 1", CATEGORY));

      await combobox().fill("gro");

      expect(options()).toEqual(["Groceries", "Create category “gro”"]);
      await userEvent.keyboard("{Enter}");
      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 1, field: "category", patch: { category: "Groceries" } },
      ]);
    });

    it("creates the category when its item is picked with the mouse", async () => {
      await renderTable();
      await userEvent.dblClick(cellOf("Shop 1", CATEGORY));

      await combobox().fill("gro");
      await userEvent.click(page.getByRole("option", { name: "Create category “gro”" }));

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 1, field: "category", patch: { category: "gro" } },
      ]);
    });

    it("doesn't create a category when leaving the cell", async () => {
      await renderTable();
      await userEvent.dblClick(cellOf("Shop 1", CATEGORY));

      await combobox().fill("Pets");
      combobox().element().blur();

      await expect
        .element(page.getByText("There's no category named “Pets”. The change was undone."))
        .toBeVisible();
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("clears the category with empty text and Enter", async () => {
      await renderTable();
      await userEvent.dblClick(cellOf("Corner Market", CATEGORY));

      await combobox().fill("");
      await expect.element(highlighted()).not.toBeInTheDocument();
      await userEvent.keyboard("{Enter}");

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "category", patch: { category: null } },
      ]);
    });

    it("shows an empty account's error instead of the menu", async () => {
      await renderTable();
      await userEvent.dblClick(cellOf("Corner Market", ACCOUNT));

      await combobox().fill("");
      await userEvent.keyboard("{Enter}");

      await expect.element(page.getByRole("alert")).toHaveTextContent("Choose an account");
      await expect.element(page.getByRole("listbox")).not.toBeInTheDocument();
      await combobox().fill("S");
      await expect.element(page.getByRole("listbox")).toBeVisible();
    });

    describe("when the options change while the menu is open", () => {
      it("keeps the same option highlighted when one is added above it", async () => {
        const screen = await renderTable();
        await userEvent.dblClick(cellOf("Corner Market", CATEGORY));

        await screen.rerender(table(["Coffee", ...CATEGORIES]));

        await expect.element(highlighted()).toHaveTextContent("Groceries");
        await userEvent.keyboard("{Enter}");
        expect(onCommit).not.toHaveBeenCalled();
      });

      it("keeps the same option highlighted when one above it is removed", async () => {
        const screen = await renderTable();
        await userEvent.dblClick(cellOf("Corner Market", CATEGORY));

        await screen.rerender(table(["Groceries"]));

        await expect.element(highlighted()).toHaveTextContent("Groceries");
        await userEvent.keyboard("{Enter}");
        expect(onCommit).not.toHaveBeenCalled();
      });

      it("falls back to the default highlight when the highlighted option is removed", async () => {
        const screen = await renderTable();
        await userEvent.dblClick(cellOf("Shop 1", CATEGORY));
        await combobox().fill("i");
        await userEvent.keyboard("{ArrowDown}");
        await expect.element(highlighted()).toHaveTextContent("Groceries");

        await screen.rerender(table(["Dining out"]));

        // The first match, not whatever is now second (the create item).
        await expect.element(highlighted()).toHaveTextContent("Dining out");
      });
    });

    it("opens the menu above a cell near the bottom of the window", async () => {
      await renderTable();
      const lastVisible = [...renderedRows()]
        .filter((row) => row.getBoundingClientRect().bottom <= window.innerHeight)
        .at(-1)!;
      const cell = page.elementLocator(cellIn(lastVisible, ACCOUNT));

      await userEvent.dblClick(cell);

      const menu = page.getByRole("listbox").element().parentElement!.getBoundingClientRect();
      expect(menu.bottom).toBeLessThanOrEqual(cell.element().getBoundingClientRect().top);
    });

    it("moves the menu above the cell when scrolling takes it near the bottom of the window", async () => {
      await renderTable();
      window.scrollTo(0, ROW_HEIGHT * 40);
      // A row in the top half of the window, once the rows there are rendered.
      const inTopHalf = () =>
        [...renderedRows()].find((row) => {
          const { top } = row.getBoundingClientRect();
          return top > window.innerHeight / 3 && top < window.innerHeight / 2;
        });
      await expect.poll(inTopHalf).toBeDefined();
      const cell = cellIn(inTopHalf()!, ACCOUNT);
      await userEvent.dblClick(page.elementLocator(cell));
      const menu = () => page.getByRole("listbox").element().parentElement!.getBoundingClientRect();
      await expect.element(page.getByRole("listbox")).toBeVisible();
      expect(menu().top).toBeGreaterThanOrEqual(cell.getBoundingClientRect().bottom);

      // Up, so the cell ends a row above the bottom of the window.
      window.scrollBy(0, cell.getBoundingClientRect().bottom - (window.innerHeight - ROW_HEIGHT));

      await expect.poll(() => menu().bottom <= cell.getBoundingClientRect().top).toBe(true);
    });

    it("shows the menu over the column headers when it opens up into them", async () => {
      await page.viewport(1280, 150);
      await renderTable();
      const lastVisible = [...renderedRows()]
        .filter((row) => row.getBoundingClientRect().bottom <= window.innerHeight)
        .at(-1)!;

      await userEvent.dblClick(page.elementLocator(cellIn(lastVisible, ACCOUNT)));

      const menu = page.getByRole("listbox").element().parentElement!;
      const header = page.getByRole("columnheader").first().element().getBoundingClientRect();
      const box = menu.getBoundingClientRect();
      expect(box.top).toBeLessThan(header.bottom);
      expect(menu.contains(document.elementFromPoint(box.left + 10, box.top + 2))).toBe(true);
    });

    it("shows an error above a cell near the bottom of the window", async () => {
      await renderTable();
      const lastVisible = [...renderedRows()]
        .filter((row) => row.getBoundingClientRect().bottom <= window.innerHeight)
        .at(-1)!;
      const cell = cellIn(lastVisible, AMOUNT);
      await userEvent.dblClick(page.elementLocator(cell));

      await amountInput().fill("1.2.3");
      await userEvent.keyboard("{Enter}");

      const error = page.getByRole("alert");
      await expect.element(error).toBeVisible();
      expect(error.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(
        cell.getBoundingClientRect().top,
      );
    });

    it("keeps the highlighted option scrolled into view", async () => {
      const many = Array.from({ length: 30 }, (_, i) => `Category ${String(i).padStart(2, "0")}`);
      await render(
        <TransactionsTable
          rows={rows.slice(0, 5)}
          maxRowNumber={5}
          categories={many}
          accounts={ACCOUNTS}
          currencies={CURRENCIES}
          onCommit={onCommit}
          lastUndoOrRedo={null}
          onUndoOrRedo={onUndoOrRedo}
        />,
      );
      await userEvent.dblClick(cellOf("Shop 1", CATEGORY));
      await userEvent.keyboard("{ArrowDown}".repeat(20));

      const list = page.getByRole("listbox").element().getBoundingClientRect();
      const option = highlighted().element().getBoundingClientRect();
      expect(highlighted().element().textContent).toBe("Category 19");
      expect(option.top).toBeGreaterThanOrEqual(list.top);
      expect(option.bottom).toBeLessThanOrEqual(list.bottom);
    });
  });
});
