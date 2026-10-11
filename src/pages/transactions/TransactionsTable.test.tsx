import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { page, userEvent, type Locator } from "vitest/browser";
import { render } from "vitest-browser-react";
import toast, { Toaster } from "react-hot-toast";
import type { TransactionRow } from "../../db/queries/transactions.ts";
import { mouse, pointIn } from "../../test/mouse.ts";
import TransactionsTable, { ROW_HEIGHT } from "./TransactionsTable.tsx";

const ROW_COUNT = 100_000;
const CATEGORIES = ["Dining out", "Groceries"];
const ACCOUNTS = ["Everyday Checking", "Rewards Credit Card", "Savings"];

function makeRows(count: number): TransactionRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `t${i}`,
    naive_date: "2026-10-10",
    account_name: "Everyday Checking",
    counterparty: i === 0 ? "Corner Market" : `Shop ${i}`,
    category: i % 2 === 0 ? "Groceries" : null,
    amount: i === 0 ? -12_345_000 : -(i * 100),
    currency: "USD",
    remarks: null,
  }));
}

const rows = makeRows(ROW_COUNT);
let onCommit: Mock<ComponentProps<typeof TransactionsTable>["onCommit"]>;

beforeEach(async () => {
  onCommit = vi.fn();
  // Toasts live in a global store; one left from an earlier test would cover the cells.
  toast.remove();
  await page.viewport(1280, 800);
  window.scrollTo(0, 0);
});

function table(categories = CATEGORIES) {
  return (
    <>
      <TransactionsTable
        rows={rows}
        categories={categories}
        accounts={ACCOUNTS}
        onCommit={onCommit}
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

/** Presses the mouse on the left half of character `index` of an element's text. */
async function pressAtCharacter(locator: Locator, index: number) {
  const point = characterPoint(locator, index);
  const box = locator.element().getBoundingClientRect();
  await userEvent.click(locator, { position: { x: point.x - box.left, y: box.height / 2 } });
}

const input = () => page.getByRole("textbox");
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
const selectedCells = () => [
  ...document.querySelectorAll('[role="gridcell"][aria-selected="true"]'),
];
const textSelection = () => {
  const element = input().element() as HTMLInputElement;
  return [element.selectionStart, element.selectionEnd];
};

/** Renders the table and makes a cell active, without editing it. */
async function activate(text: string, column: number) {
  await renderTable();
  await userEvent.click(cellOf(text, column));
  await userEvent.keyboard("{Escape}");
  await expect.element(grid()).toHaveFocus();
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
    it("shows the amount with its currency", async () => {
      await renderTable();

      const cell = page.getByText("-1,234.50").element().closest('[role="gridcell"]')!;
      expect(cell.textContent).toBe("USD -1,234.50");
    });
  });

  describe("editing", () => {
    it("turns a cell into an input on mouse down, with the caret where it was pressed", async () => {
      await renderTable();

      await pressAtCharacter(page.getByText("Corner Market"), 3);

      await expect.element(input()).toHaveFocus();
      expect(input().element()).toHaveProperty("value", "Corner Market");
      expect((input().element() as HTMLInputElement).selectionStart).toBe(3);
    });

    it("edits an amount without its currency or grouping", async () => {
      await renderTable();

      // Before the "2" in "-1,234.50".
      await pressAtCharacter(page.getByText("-1,234.50"), 3);

      expect(input().element()).toHaveProperty("value", "-1234.50");
      expect((input().element() as HTMLInputElement).selectionStart).toBe(2);
    });

    it("commits on Enter", async () => {
      await renderTable();
      await pressAtCharacter(page.getByText("Corner Market"), 0);

      await input().fill("Corner Shop");
      await userEvent.keyboard("{Enter}");

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "counterparty", value: "Corner Shop" },
      ]);
      await expect.element(input()).not.toBeInTheDocument();
    });

    it("parses the value before committing", async () => {
      await renderTable();
      await pressAtCharacter(page.getByText("-1,234.50"), 0);

      await input().fill("-2,000.5");
      await userEvent.keyboard("{Enter}");

      expect(onCommit).toHaveBeenCalledWith([{ rowIndex: 0, field: "amount", value: -20_005_000 }]);
    });

    it("commits when the input loses focus", async () => {
      await renderTable();
      await pressAtCharacter(page.getByText("Corner Market"), 0);

      await input().fill("Corner Shop");
      input().element().blur();

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "counterparty", value: "Corner Shop" },
      ]);
    });

    it("reverts on Escape", async () => {
      await renderTable();
      await pressAtCharacter(page.getByText("Corner Market"), 0);

      await input().fill("Corner Shop");
      await userEvent.keyboard("{Escape}");

      await expect.element(input()).not.toBeInTheDocument();
      expect(onCommit).not.toHaveBeenCalled();
      await expect.element(page.getByText("Corner Market")).toBeVisible();
    });

    it("doesn't commit an unchanged value", async () => {
      await renderTable();
      await pressAtCharacter(page.getByText("Corner Market"), 0);

      await userEvent.keyboard("{Enter}");

      expect(onCommit).not.toHaveBeenCalled();
    });

    it.each(["-1234.5", " -1234.50 ", "-1,234.50"])(
      "doesn't commit the same amount written as %j",
      async (text) => {
        await renderTable();
        await pressAtCharacter(page.getByText("-1,234.50"), 0);

        await input().fill(text);
        await userEvent.keyboard("{Enter}");

        expect(onCommit).not.toHaveBeenCalled();
      },
    );

    it("doesn't commit a counterparty that only gained spaces", async () => {
      await renderTable();
      await pressAtCharacter(page.getByText("Corner Market"), 0);

      await input().fill("Corner Market ");
      await userEvent.keyboard("{Enter}");

      expect(onCommit).not.toHaveBeenCalled();
    });

    it("keeps an invalid value open with the error on Enter", async () => {
      await renderTable();
      await pressAtCharacter(page.getByText("-1,234.50"), 0);

      await input().fill("twelve");
      await userEvent.keyboard("{Enter}");

      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("Enter a number, like -12.50");
      await expect.element(input()).toHaveAttribute("aria-invalid", "true");
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("undoes an invalid value on blur and says why", async () => {
      await renderTable();
      await pressAtCharacter(page.getByText("Corner Market"), 0);

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
      await pressAtCharacter(page.getByText("Corner Market"), 0);
      await input().fill("Corner Shop");

      await pressAtCharacter(page.getByText("Shop 1", { exact: true }), 0);

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "counterparty", value: "Corner Shop" },
      ]);
      expect(input().element()).toHaveProperty("value", "Shop 1");
    });

    it("keeps the edited row when it scrolls out of view", async () => {
      await renderTable();
      await pressAtCharacter(page.getByText("Corner Market"), 0);
      await input().fill("Corner Shop");

      window.scrollTo(0, document.documentElement.scrollHeight);
      await expect.element(page.getByText(`Shop ${ROW_COUNT - 1}`)).toBeInTheDocument();

      expect(input().element()).toHaveProperty("value", "Corner Shop");
    });

    it("keeps the cell active after Enter, with the grid focused", async () => {
      await renderTable();
      await pressAtCharacter(page.getByText("Corner Market"), 0);
      await input().fill("Corner Shop");

      await userEvent.keyboard("{Enter}");

      await expect.element(input()).not.toBeInTheDocument();
      await expect.element(grid()).toHaveFocus();
      expect(activeCell()).toBe(cellOf("Corner Market", COUNTERPARTY).element());
    });

    it("keeps the cell active after Escape", async () => {
      await renderTable();
      await pressAtCharacter(page.getByText("Corner Market"), 0);

      await userEvent.keyboard("{Escape}");

      await expect.element(grid()).toHaveFocus();
      expect(activeCell()).toBe(cellOf("Corner Market", COUNTERPARTY).element());
    });
  });

  describe("keyboard", () => {
    it("starts at the first cell when the grid is tabbed into", async () => {
      await renderTable();

      await userEvent.tab();

      await expect.element(grid()).toHaveFocus();
      expect(activeCell()?.textContent).toBe("2026-10-10");
    });

    it("doesn't select a cell when a column header is clicked", async () => {
      await renderTable();

      await userEvent.click(page.getByRole("columnheader").first());

      expect(activeCell()).toBeNull();
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

      await userEvent.keyboard("{ArrowUp}{ArrowLeft}");

      expect(activeCell()).toBe(cellOf("Corner Market", DATE).element());
    });

    it("starts editing with Enter, caret at the end", async () => {
      await activate("Corner Market", COUNTERPARTY);

      await userEvent.keyboard("{Enter}");

      await expect.element(input()).toHaveFocus();
      expect(input().element()).toHaveProperty("value", "Corner Market");
      expect((input().element() as HTMLInputElement).selectionStart).toBe("Corner Market".length);
    });

    it("starts editing with F2", async () => {
      await activate("Corner Market", COUNTERPARTY);

      await userEvent.keyboard("{F2}");

      await expect.element(input()).toHaveFocus();
    });

    it("replaces the content with what's typed", async () => {
      await activate("Corner Market", COUNTERPARTY);

      await userEvent.keyboard("Z");

      await expect.element(input()).toHaveFocus();
      expect(input().element()).toHaveProperty("value", "Z");
      expect((input().element() as HTMLInputElement).selectionStart).toBe(1);
      await userEvent.keyboard("oo{Enter}");
      expect(onCommit).toHaveBeenCalledWith([{ rowIndex: 0, field: "counterparty", value: "Zoo" }]);
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
      await pressAtCharacter(page.getByText("Corner Market"), 0);
      await input().fill("Corner Shop");

      await userEvent.keyboard("{Tab}");

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "counterparty", value: "Corner Shop" },
      ]);
      await expect.element(input()).not.toBeInTheDocument();
      await expect.element(grid()).toHaveFocus();
      expect(activeCell()).toBe(cellOf("Corner Market", CATEGORY).element());
    });

    it("saves with Shift+Tab and moves to the previous cell", async () => {
      await renderTable();
      await pressAtCharacter(page.getByText("Corner Market"), 0);
      await input().fill("Corner Shop");

      await userEvent.keyboard("{Shift>}{Tab}{/Shift}");

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "counterparty", value: "Corner Shop" },
      ]);
      expect(activeCell()).toBe(cellOf("Corner Market", ACCOUNT).element());
    });

    it("keeps an invalid value open with the error on Tab", async () => {
      await renderTable();
      await pressAtCharacter(page.getByText("-1,234.50"), 0);

      await input().fill("twelve");
      await userEvent.keyboard("{Tab}");

      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("Enter a number, like -12.50");
      await expect.element(input()).toHaveFocus();
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
      await userEvent.click(cellOf("Corner Market", REMARKS));

      await input().fill("Weekly shop");
      await userEvent.keyboard("{Tab}");

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "remarks", value: "Weekly shop" },
      ]);
      expect(activeCell()).toBe(cellOf("Shop 1", DATE).element());
    });

    it("lets Tab leave the grid from its last cell", async () => {
      await activate("Corner Market", DATE);
      await userEvent.keyboard("{Control>}{End}{/Control}");

      await userEvent.keyboard("{Tab}");

      await expect.element(grid()).not.toHaveFocus();
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
      await pressAtCharacter(page.getByText("Corner Market"), 0);

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

      expect(onCommit).toHaveBeenCalledWith([{ rowIndex: 0, field: "category", value: null }]);
      await expect.element(combobox()).not.toBeInTheDocument();
      await expect.element(grid()).toHaveFocus();
      expect(activeCell()).toBe(cellOf("Corner Market", CATEGORY).element());
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

        // Rows 0 and 2 have a category (row 1 has none to clear);
        // counterparties and amounts can't be empty.
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(onCommit).toHaveBeenCalledWith([
          { rowIndex: 0, field: "category", value: null },
          { rowIndex: 2, field: "category", value: null },
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

  describe("cursor", () => {
    it("shows the text cursor only over the active cell", async () => {
      await activate("Corner Market", COUNTERPARTY);

      expect(getComputedStyle(page.getByText("Corner Market").element()).cursor).toBe("text");
      expect(getComputedStyle(page.getByText("Shop 1", { exact: true }).element()).cursor).toBe(
        "default",
      );
      expect(getComputedStyle(cellOf("Corner Market", ACCOUNT).element()).cursor).toBe("default");
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
      await pressAtCharacter(page.getByText("Corner Market"), 0);
      await input().fill("Corner Shop");

      await mouse.down(pointIn(input().element()));
      await mouse.move(pointIn(cellOf("Shop 1", COUNTERPARTY).element()));
      await mouse.up(pointIn(cellOf("Shop 1", COUNTERPARTY).element()));

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "counterparty", value: "Corner Shop" },
      ]);
      expect(selectedCells()).toHaveLength(2);
      await expect.element(input()).not.toBeInTheDocument();
    });

    it("selects text while the drag stays in the cell", async () => {
      await renderTable();
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
      await renderTable();
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
      await renderTable();
      const text = page.getByText("Corner Market");
      const from = characterPoint(text, 2);
      const back = characterPoint(text, 8);
      const below = pointIn(cellOf("Shop 1", COUNTERPARTY).element());

      await mouse.down(from);
      await mouse.move(below);
      expect(selectedCells()).toHaveLength(2);
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
      await renderTable();
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
      await renderTable();
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
      await renderTable();
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
      await renderTable();
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

    it("selects a word on double-click", async () => {
      await renderTable();
      const text = page.getByText("Corner Market");
      const box = text.element().getBoundingClientRect();
      const point = characterPoint(text, 9);

      await userEvent.dblClick(text, {
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

      await userEvent.click(cellOf("Corner Market", ACCOUNT));

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
      await userEvent.click(cellOf("Corner Market", ACCOUNT));

      await combobox().fill("CARD");

      expect(options()).toEqual(["Rewards Credit Card"]);
      await expect.element(highlighted()).toHaveTextContent("Rewards Credit Card");
    });

    it("picks the highlighted option on Enter", async () => {
      await renderTable();
      await userEvent.click(cellOf("Corner Market", ACCOUNT));

      await combobox().fill("sav");
      await userEvent.keyboard("{Enter}");

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "account_name", value: "Savings" },
      ]);
      await expect.element(combobox()).not.toBeInTheDocument();
    });

    it("moves the highlight with the arrow keys", async () => {
      await renderTable();
      await userEvent.click(cellOf("Corner Market", ACCOUNT));

      await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowUp}");

      await expect.element(highlighted()).toHaveTextContent("Rewards Credit Card");
      await userEvent.keyboard("{Enter}");
      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "account_name", value: "Rewards Credit Card" },
      ]);
    });

    it("picks an option with the mouse", async () => {
      await renderTable();
      await userEvent.click(cellOf("Corner Market", ACCOUNT));

      await userEvent.click(page.getByRole("option", { name: "Savings" }));

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "account_name", value: "Savings" },
      ]);
      await expect.element(combobox()).not.toBeInTheDocument();
    });

    it("says when no account matches, and doesn't save on Enter", async () => {
      await renderTable();
      await userEvent.click(cellOf("Corner Market", ACCOUNT));

      await combobox().fill("fdsafjsdoif");
      await userEvent.keyboard("{Enter}");

      await expect.element(page.getByText("No account found")).toBeVisible();
      await expect.element(combobox()).toHaveAttribute("aria-expanded", "false");
      await expect.element(combobox()).toHaveFocus();
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("saves an exact match when leaving the cell, in the option's own case", async () => {
      await renderTable();
      await userEvent.click(cellOf("Corner Market", ACCOUNT));

      await combobox().fill("savings");
      combobox().element().blur();

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "account_name", value: "Savings" },
      ]);
    });

    it("saves the highlighted account when leaving the cell", async () => {
      await renderTable();
      await userEvent.click(cellOf("Corner Market", ACCOUNT));

      await combobox().fill("Sav");
      combobox().element().blur();

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "account_name", value: "Savings" },
      ]);
    });

    it("saves an option picked with the arrow keys when leaving the cell", async () => {
      await renderTable();
      await userEvent.click(cellOf("Corner Market", ACCOUNT));

      await userEvent.keyboard("{ArrowDown}");
      combobox().element().blur();

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 0, field: "account_name", value: "Rewards Credit Card" },
      ]);
    });

    it("undoes an account that names no option when leaving the cell", async () => {
      await renderTable();
      await userEvent.click(cellOf("Corner Market", ACCOUNT));

      await combobox().fill("fdsafjsdoif");
      combobox().element().blur();

      await expect
        .element(page.getByText("There's no account named “fdsafjsdoif”. The change was undone."))
        .toBeVisible();
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("saves the highlighted existing category when leaving the cell", async () => {
      await renderTable();
      await userEvent.click(cellOf("Shop 1", CATEGORY));

      await combobox().fill("gro");
      combobox().element().blur();

      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 1, field: "category", value: "Groceries" },
      ]);
    });

    it("doesn't create a category highlighted with the arrow keys when leaving the cell", async () => {
      await renderTable();
      await userEvent.click(cellOf("Shop 1", CATEGORY));

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
      await userEvent.click(cellOf("Corner Market", CATEGORY));

      await combobox().fill("Pets");

      expect(options()).toEqual(["Create category “Pets”"]);
      await userEvent.keyboard("{Enter}");
      expect(onCommit).toHaveBeenCalledWith([{ rowIndex: 0, field: "category", value: "Pets" }]);
    });

    it("picks the first matching category over creating one", async () => {
      await renderTable();
      await userEvent.click(cellOf("Shop 1", CATEGORY));

      await combobox().fill("gro");

      expect(options()).toEqual(["Groceries", "Create category “gro”"]);
      await userEvent.keyboard("{Enter}");
      expect(onCommit).toHaveBeenCalledWith([
        { rowIndex: 1, field: "category", value: "Groceries" },
      ]);
    });

    it("creates the category when its item is picked with the mouse", async () => {
      await renderTable();
      await userEvent.click(cellOf("Shop 1", CATEGORY));

      await combobox().fill("gro");
      await userEvent.click(page.getByRole("option", { name: "Create category “gro”" }));

      expect(onCommit).toHaveBeenCalledWith([{ rowIndex: 1, field: "category", value: "gro" }]);
    });

    it("doesn't create a category when leaving the cell", async () => {
      await renderTable();
      await userEvent.click(cellOf("Shop 1", CATEGORY));

      await combobox().fill("Pets");
      combobox().element().blur();

      await expect
        .element(page.getByText("There's no category named “Pets”. The change was undone."))
        .toBeVisible();
      expect(onCommit).not.toHaveBeenCalled();
    });

    it("clears the category with empty text and Enter", async () => {
      await renderTable();
      await userEvent.click(cellOf("Corner Market", CATEGORY));

      await combobox().fill("");
      await expect.element(highlighted()).not.toBeInTheDocument();
      await userEvent.keyboard("{Enter}");

      expect(onCommit).toHaveBeenCalledWith([{ rowIndex: 0, field: "category", value: null }]);
    });

    it("shows an empty account's error instead of the menu", async () => {
      await renderTable();
      await userEvent.click(cellOf("Corner Market", ACCOUNT));

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
        await userEvent.click(cellOf("Corner Market", CATEGORY));

        await screen.rerender(table(["Coffee", ...CATEGORIES]));

        await expect.element(highlighted()).toHaveTextContent("Groceries");
        await userEvent.keyboard("{Enter}");
        expect(onCommit).not.toHaveBeenCalled();
      });

      it("keeps the same option highlighted when one above it is removed", async () => {
        const screen = await renderTable();
        await userEvent.click(cellOf("Corner Market", CATEGORY));

        await screen.rerender(table(["Groceries"]));

        await expect.element(highlighted()).toHaveTextContent("Groceries");
        await userEvent.keyboard("{Enter}");
        expect(onCommit).not.toHaveBeenCalled();
      });

      it("falls back to the default highlight when the highlighted option is removed", async () => {
        const screen = await renderTable();
        await userEvent.click(cellOf("Shop 1", CATEGORY));
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

      await userEvent.click(cell);

      const menu = page.getByRole("listbox").element().parentElement!.getBoundingClientRect();
      expect(menu.bottom).toBeLessThanOrEqual(cell.element().getBoundingClientRect().top);
    });

    it("keeps the highlighted option scrolled into view", async () => {
      const many = Array.from({ length: 30 }, (_, i) => `Category ${String(i).padStart(2, "0")}`);
      await render(
        <TransactionsTable
          rows={rows.slice(0, 5)}
          categories={many}
          accounts={ACCOUNTS}
          onCommit={onCommit}
        />,
      );
      await userEvent.click(cellOf("Shop 1", CATEGORY));
      await userEvent.keyboard("{ArrowDown}".repeat(20));

      const list = page.getByRole("listbox").element().getBoundingClientRect();
      const option = highlighted().element().getBoundingClientRect();
      expect(highlighted().element().textContent).toBe("Category 19");
      expect(option.top).toBeGreaterThanOrEqual(list.top);
      expect(option.bottom).toBeLessThanOrEqual(list.bottom);
    });
  });
});
