import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { page, userEvent, type Locator } from "vitest/browser";
import { render } from "vitest-browser-react";
import { Toaster } from "sonner";
import type { Edit } from "../../db/databaseContext.ts";
import type { Moved } from "../../db/editHistory.ts";
import type { Currency, EditedCell, TransactionRow } from "../../db/queries/transactions.ts";
import { mouse, pointIn } from "../../test/mouse.ts";
import TransactionsTable, { ROW_HEIGHT } from "./TransactionsTable.tsx";

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

function table(categories = CATEGORIES, shown = rows) {
  return (
    <>
      <TransactionsTable
        rows={shown}
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

/** The cell in `column` (0-based) of the row showing `text`. */
function cellOf(text: string, column: number) {
  const row = page.getByText(text, { exact: true }).element().closest('[role="row"]')!;
  return page.elementLocator(row.children[column]!);
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

    it("starts at the first header when a grid without rows is tabbed into", async () => {
      await render(
        <TransactionsTable
          rows={[]}
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

    it("drops the range with Escape", async () => {
      await activate("Corner Market", COUNTERPARTY);
      await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");

      await userEvent.keyboard("{Escape}");

      expect(selectedCells()).toEqual([cellOf("Corner Market", COUNTERPARTY).element()]);
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
          description: "an edit",
        },
      },
    });

    const tableShowing = (moved: Moved<Edit> | null) => (
      <TransactionsTable
        rows={rows}
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

  describe("when the rows change", () => {
    it("keeps the active cell on a row that's still there", async () => {
      const screen = await render(table());
      await makeActive("Shop 3", COUNTERPARTY);

      await screen.rerender(
        <TransactionsTable
          rows={rows.slice(0, 2)}
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
      const box = lastVisible.children[COUNTERPARTY]!.getBoundingClientRect();
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
      const cell = page.elementLocator(lastVisible.children[ACCOUNT]!);

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
      const cell = inTopHalf()!.children[ACCOUNT]!;
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

      await userEvent.dblClick(page.elementLocator(lastVisible.children[ACCOUNT]!));

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
      const cell = lastVisible.children[AMOUNT]!;
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
