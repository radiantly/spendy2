import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { page, userEvent, type Locator } from "vitest/browser";
import { render } from "vitest-browser-react";
import { Toaster } from "react-hot-toast";
import type { TransactionRow } from "../../db/queries/transactions.ts";
import TransactionsTable, { ROW_HEIGHT } from "./TransactionsTable.tsx";

const ROW_COUNT = 100_000;
const CATEGORIES = new Set(["Groceries", "Dining out"]);

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
  await page.viewport(1280, 800);
  window.scrollTo(0, 0);
});

async function renderTable() {
  return render(
    <>
      <TransactionsTable rows={rows} categories={CATEGORIES} onCommit={onCommit} />
      <Toaster />
    </>,
  );
}

/** Presses the mouse on the left half of character `index` of an element's text. */
async function pressAtCharacter(locator: Locator, index: number) {
  const element = locator.element();
  const range = document.createRange();
  range.setStart(element.firstChild!, index);
  range.setEnd(element.firstChild!, index + 1);
  const char = range.getBoundingClientRect();
  const box = element.getBoundingClientRect();
  await userEvent.click(locator, {
    position: { x: char.left - box.left + 1, y: box.height / 2 },
  });
}

const input = () => page.getByRole("textbox");
const renderedRows = () =>
  document.querySelectorAll('[role="rowgroup"] + [role="rowgroup"] > [role="row"]');

describe("TransactionsTable", () => {
  describe("virtualization", () => {
    it("renders only the rows near the viewport", async () => {
      await renderTable();

      expect(page.getByRole("table").element().getAttribute("aria-rowcount")).toBe(
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

      const cell = page.getByText("-1,234.50").element().closest('[role="cell"]')!;
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

      expect(onCommit).toHaveBeenCalledWith(0, "counterparty", "Corner Shop");
      await expect.element(input()).not.toBeInTheDocument();
    });

    it("parses the value before committing", async () => {
      await renderTable();
      await pressAtCharacter(page.getByText("-1,234.50"), 0);

      await input().fill("-2,000.5");
      await userEvent.keyboard("{Enter}");

      expect(onCommit).toHaveBeenCalledWith(0, "amount", -20_005_000);
    });

    it("commits when the input loses focus", async () => {
      await renderTable();
      await pressAtCharacter(page.getByText("Corner Market"), 0);

      await input().fill("Corner Shop");
      input().element().blur();

      expect(onCommit).toHaveBeenCalledWith(0, "counterparty", "Corner Shop");
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

    it("rejects a category that doesn't exist", async () => {
      await renderTable();
      const category = page.getByText("Groceries").first();
      await pressAtCharacter(category, 0);

      await input().fill("Rent");
      await userEvent.keyboard("{Enter}");

      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("There's no category named “Rent”");
    });

    it("commits the open edit when another cell is pressed", async () => {
      await renderTable();
      await pressAtCharacter(page.getByText("Corner Market"), 0);
      await input().fill("Corner Shop");

      await pressAtCharacter(page.getByText("Shop 1", { exact: true }), 0);

      expect(onCommit).toHaveBeenCalledWith(0, "counterparty", "Corner Shop");
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

    it("doesn't edit read-only cells", async () => {
      await renderTable();

      await userEvent.click(page.getByText("Everyday Checking").first());

      await expect.element(input()).not.toBeInTheDocument();
    });

    it("starts editing from the keyboard with Enter, caret at the end", async () => {
      await renderTable();
      const cell = page
        .getByText("Corner Market")
        .element()
        .closest('[role="cell"]') as HTMLElement;
      cell.focus();

      await userEvent.keyboard("{Enter}");

      expect((input().element() as HTMLInputElement).selectionStart).toBe("Corner Market".length);
    });

    it("returns focus to the cell after Enter", async () => {
      await renderTable();
      await pressAtCharacter(page.getByText("Corner Market"), 0);

      await userEvent.keyboard("{Enter}");

      expect(document.activeElement?.textContent).toBe("Corner Market");
    });
  });
});
