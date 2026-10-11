import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { page, userEvent, type Locator } from "vitest/browser";
import { render } from "vitest-browser-react";
import toast, { Toaster } from "react-hot-toast";
import type { TransactionRow } from "../../db/queries/transactions.ts";
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
const ACCOUNT = 1;
const CATEGORY = 3;
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

      expect(onCommit).toHaveBeenCalledWith(0, "account_name", "Savings");
      await expect.element(combobox()).not.toBeInTheDocument();
    });

    it("moves the highlight with the arrow keys", async () => {
      await renderTable();
      await userEvent.click(cellOf("Corner Market", ACCOUNT));

      await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowUp}");

      await expect.element(highlighted()).toHaveTextContent("Rewards Credit Card");
      await userEvent.keyboard("{Enter}");
      expect(onCommit).toHaveBeenCalledWith(0, "account_name", "Rewards Credit Card");
    });

    it("picks an option with the mouse", async () => {
      await renderTable();
      await userEvent.click(cellOf("Corner Market", ACCOUNT));

      await userEvent.click(page.getByRole("option", { name: "Savings" }));

      expect(onCommit).toHaveBeenCalledWith(0, "account_name", "Savings");
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

      expect(onCommit).toHaveBeenCalledWith(0, "account_name", "Savings");
    });

    it("saves the highlighted account when leaving the cell", async () => {
      await renderTable();
      await userEvent.click(cellOf("Corner Market", ACCOUNT));

      await combobox().fill("Sav");
      combobox().element().blur();

      expect(onCommit).toHaveBeenCalledWith(0, "account_name", "Savings");
    });

    it("saves an option picked with the arrow keys when leaving the cell", async () => {
      await renderTable();
      await userEvent.click(cellOf("Corner Market", ACCOUNT));

      await userEvent.keyboard("{ArrowDown}");
      combobox().element().blur();

      expect(onCommit).toHaveBeenCalledWith(0, "account_name", "Rewards Credit Card");
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

      expect(onCommit).toHaveBeenCalledWith(1, "category", "Groceries");
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
      expect(onCommit).toHaveBeenCalledWith(0, "category", "Pets");
    });

    it("picks the first matching category over creating one", async () => {
      await renderTable();
      await userEvent.click(cellOf("Shop 1", CATEGORY));

      await combobox().fill("gro");

      expect(options()).toEqual(["Groceries", "Create category “gro”"]);
      await userEvent.keyboard("{Enter}");
      expect(onCommit).toHaveBeenCalledWith(1, "category", "Groceries");
    });

    it("creates the category when its item is picked with the mouse", async () => {
      await renderTable();
      await userEvent.click(cellOf("Shop 1", CATEGORY));

      await combobox().fill("gro");
      await userEvent.click(page.getByRole("option", { name: "Create category “gro”" }));

      expect(onCommit).toHaveBeenCalledWith(1, "category", "gro");
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

      expect(onCommit).toHaveBeenCalledWith(0, "category", null);
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
