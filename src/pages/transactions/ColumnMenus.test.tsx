import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { CategoryParent } from "../../db/queries/overview.ts";
import type { ListedTransaction } from "../../db/queries/transactions.ts";
import { ColumnMenu } from "./ColumnMenus.tsx";
import TransactionsTable, { type TransactionChange } from "./TransactionsTable.tsx";
import { DEFAULT_VIEW, filterValues, type TransactionsView } from "./view.ts";

// A fixed today; faking Date itself stops expect.element's retries.
vi.mock("../../lib/period.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/period.ts")>()),
  today: () => "2026-10-18",
}));

const ACCOUNTS = ["Card", "Checking", "Savings"];
const CATEGORIES: CategoryParent[] = [
  { name: "Dining out", parent: "Food" },
  { name: "Food", parent: null },
  { name: "Groceries", parent: "Food" },
  { name: "Rent", parent: null },
];

let seq = 0;
function transaction(overrides: Partial<ListedTransaction> = {}): ListedTransaction {
  seq++;
  return {
    id: `t${seq}`,
    seq,
    naive_date: "2026-10-10",
    account_name: "Checking",
    counterparty: `Shop ${seq}`,
    category: "Groceries",
    amount: -100,
    decimals: 2,
    currency: "USD",
    remarks: null,
    transfer_account: null,
    duplicate_of: null,
    conversions: {},
    ...overrides,
  };
}

/** The view the menus last set. */
let view: TransactionsView;
let onCommit: (changes: TransactionChange[]) => void;

beforeEach(async () => {
  seq = 0;
  view = DEFAULT_VIEW;
  onCommit = vi.fn();
  await page.viewport(1280, 800);
});

/** The table, with its header menus setting a view (which, unlike the page, it doesn't apply). */
function Table({
  rows,
  categories = CATEGORIES,
}: {
  rows: ListedTransaction[];
  categories?: CategoryParent[];
}) {
  const [current, setCurrent] = useState(DEFAULT_VIEW);
  const names = { accounts: ACCOUNTS, categories: categories.map(({ name }) => name) };
  return (
    <TransactionsTable
      rows={rows}
      categories={names.categories}
      accounts={ACCOUNTS}
      currencies={[]}
      onCommit={onCommit}
      lastUndoOrRedo={null}
      onUndoOrRedo={() => {}}
      menus={{
        sort: current.sort,
        render: (column, header) => (
          <ColumnMenu
            column={column}
            header={header}
            view={current}
            onViewChange={(next) => {
              view = next;
              setCurrent(next);
            }}
            accounts={ACCOUNTS}
            categories={categories}
            values={filterValues(rows, names)}
          />
        ),
      }}
    />
  );
}

const renderTable = (rows = [transaction(), transaction()]) => render(<Table rows={rows} />);

const header = (name: string) => page.getByRole("columnheader", { name: new RegExp(name) });
const headerButton = (name: string) => page.getByRole("button", { name: new RegExp(`^${name}`) });
const menu = (name: string) => page.getByRole("dialog", { name: new RegExp(`^${name}`) });
const radio = (name: string) => page.getByRole("radio", { name: new RegExp(`^${name}`) });
const checkbox = (name: string) => page.getByRole("checkbox", { name: new RegExp(`^${name}`) });
const grid = () => page.getByRole("grid");
const active = () =>
  document.getElementById(grid().element().getAttribute("aria-activedescendant") ?? "");
/** The checkboxes' names in the open menu, in order. */
const checkboxes = () =>
  page
    .getByRole("checkbox")
    .elements()
    .map((box) => box.closest("label")!.querySelector(".truncate")!.textContent);

async function open(name: string) {
  await userEvent.click(headerButton(name));
  await expect.element(menu(name)).toBeVisible();
}

describe("opening and closing", () => {
  it("opens a header's menu when it's pressed, focusing the menu", async () => {
    await renderTable();

    await userEvent.click(headerButton("Date"));

    await expect.element(menu("Date")).toBeVisible();
    await expect.element(menu("Date")).toHaveFocus();
  });

  it("moves through a menu opened by pointer with Tab", async () => {
    await renderTable();
    await open("Date");

    await userEvent.keyboard("{Tab}");

    await expect.element(radio("Recent transactions first")).toHaveFocus();
  });

  it("closes it with Escape, back on the header with the grid focused", async () => {
    await renderTable();
    await open("Date");

    await userEvent.keyboard("{Escape}");

    await expect.element(menu("Date")).not.toBeInTheDocument();
    await expect.element(grid()).toHaveFocus();
    expect(active()).toBe(header("Date").element());
  });

  it("opens one menu at a time", async () => {
    await renderTable();
    await open("Date");

    await open("Account");

    await expect.element(menu("Date")).not.toBeInTheDocument();
  });

  it("opens the active header's menu with Enter, from the first row", async () => {
    await renderTable();
    await userEvent.click(page.getByText("Shop 1", { exact: true }));
    await userEvent.keyboard("{ArrowUp}{Enter}");

    await expect.element(menu("Counterparty")).toBeVisible();
    await expect.element(radio("A to Z")).toHaveFocus();
  });

  it("opens it with Alt+Down, and Space", async () => {
    await renderTable();
    await userEvent.click(page.getByText("Shop 1", { exact: true }));
    await userEvent.keyboard("{ArrowUp}{Alt>}{ArrowDown}{/Alt}");
    await expect.element(menu("Counterparty")).toBeVisible();
    await userEvent.keyboard("{Escape}{ArrowRight} ");

    await expect.element(menu("Category")).toBeVisible();
  });

  it("does nothing on Enter on a header without a menu", async () => {
    await renderTable();
    await userEvent.click(page.getByText("Shop 1", { exact: true }));
    await userEvent.keyboard("{ArrowUp}{End}{Enter}");

    expect(active()).toBe(header("Remarks").element());
    expect(page.getByRole("dialog").query()).toBeNull();
  });

  it("saves an edit when a header is pressed", async () => {
    await renderTable();
    await userEvent.dblClick(page.getByText("Shop 2", { exact: true }));
    await page.getByRole("textbox").fill("Corner Shop");

    await userEvent.click(headerButton("Date"));

    expect(onCommit).toHaveBeenCalledWith([
      { rowIndex: 1, field: "counterparty", patch: { counterparty: "Corner Shop" } },
    ]);
  });
});

describe("keys in a menu", () => {
  /** Opens the date menu from the keyboard, focusing its sort. */
  async function openDates() {
    await renderTable();
    await userEvent.click(page.getByText("Shop 1", { exact: true }));
    await userEvent.keyboard("{ArrowUp}{Home}{Enter}");
    await expect.element(radio("Recent transactions first")).toHaveFocus();
  }

  it("moves through every choice with Up and Down, across the groups, without picking", async () => {
    await openDates();

    await userEvent.keyboard("{ArrowDown}");
    await expect.element(radio("Oldest transactions first")).toHaveFocus();
    await expect.element(radio("Oldest transactions first")).not.toBeChecked();
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(radio("Show all")).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}");
    await expect.element(radio("Recent transactions first")).toHaveFocus();

    expect(view).toBe(DEFAULT_VIEW);
  });

  it("takes keys pressed straight after opening it", async () => {
    await renderTable();
    await userEvent.click(page.getByText("Shop 1", { exact: true }));

    await userEvent.keyboard("{ArrowUp}{Home}{Enter}{ArrowDown}{ArrowDown}");

    await expect.element(radio("Show all")).toHaveFocus();
  });

  it("goes to the first and last choice with Home and End", async () => {
    await openDates();

    await userEvent.keyboard("{End}");
    await expect.element(radio("Custom range")).toHaveFocus();
    await userEvent.keyboard("{Home}");
    await expect.element(radio("Recent transactions first")).toHaveFocus();
  });

  it("doesn't pick the choice beside with Left or Right", async () => {
    await openDates();

    await userEvent.keyboard("{ArrowRight}{ArrowLeft}");

    await expect.element(radio("Recent transactions first")).toHaveFocus();
    expect(view).toBe(DEFAULT_VIEW);
  });

  it("picks with Space, staying open", async () => {
    await openDates();

    await userEvent.keyboard("{ArrowDown} ");

    expect(view.sort).toEqual({ column: "date", direction: "ascending" });
    await expect.element(menu("Date")).toBeVisible();
  });

  it("toggles a checkbox with Space", async () => {
    await renderTable();
    await open("Account");

    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown} ");

    await expect.element(checkbox("Card")).toHaveFocus();
    expect(view.hiddenAccounts).toEqual(new Set(["Card"]));
  });

  it("closes with Enter, going on to the column's first cell", async () => {
    await openDates();
    await userEvent.keyboard("{ArrowDown} ");

    await userEvent.keyboard("{Enter}");

    await expect.element(menu("Date")).not.toBeInTheDocument();
    await expect.element(grid()).toHaveFocus();
    expect(active()).toBe(page.getByRole("row").nth(1).getByRole("gridcell").first().element());
    expect(view.sort.direction).toBe("ascending");
  });

  it("moves into a menu opened by pointer with Down", async () => {
    await renderTable();
    await open("Date");

    await userEvent.keyboard("{ArrowDown}");

    await expect.element(radio("Recent transactions first")).toHaveFocus();
  });

  it("leaves a custom range's date its own arrow keys", async () => {
    await renderTable();
    await open("Date");
    await userEvent.click(radio("Custom range"));
    const from = page.getByLabelText("From");
    (from.element() as HTMLInputElement).focus();
    await expect.element(from).toHaveFocus();

    await userEvent.keyboard("{ArrowDown}");

    await expect.element(from).toHaveFocus();
  });
});

describe("the header", () => {
  it("shows which way its column sorts", async () => {
    await renderTable();
    await expect.element(header("Date")).toHaveAttribute("aria-sort", "descending");

    await open("Account");
    await userEvent.click(radio("Z to A"));

    await expect.element(header("Account")).toHaveAttribute("aria-sort", "descending");
    await expect.element(header("Date")).not.toHaveAttribute("aria-sort");
  });

  it("says when its column filters", async () => {
    await renderTable();
    await open("Date");

    await userEvent.click(radio("This month"));
    await userEvent.keyboard("{Escape}");

    await expect.element(headerButton("Date")).toHaveAccessibleName("Date (filtered)");
  });
});

describe("the date menu", () => {
  it("sorts the oldest first", async () => {
    await renderTable();
    await open("Date");

    await userEvent.click(radio("Oldest transactions first"));

    expect(view.sort).toEqual({ column: "date", direction: "ascending" });
  });

  it("shows every date until a period is picked", async () => {
    await renderTable();
    await open("Date");
    await expect.element(radio("Show all")).toBeChecked();

    await userEvent.click(radio("Last 3 months"));

    expect(view.dates).toEqual({ kind: "last-3-months" });
  });

  it("shows the months each period covers", async () => {
    await renderTable();
    await open("Date");

    await expect.element(radio("Last 3 months")).toHaveAccessibleName(/Aug\s*–\s*Oct 2026$/);
    await expect.element(radio("Last 12 months")).toHaveAccessibleName(/Nov 2025\s*–\s*Oct 2026$/);
    await expect.element(radio("This month")).toHaveAccessibleName(/October 2026$/);
    await expect.element(radio("Last month")).toHaveAccessibleName(/September 2026$/);
  });

  it("starts a custom range from the period picked, and edits its dates", async () => {
    await renderTable();
    await open("Date");
    await userEvent.click(radio("Last month"));

    await userEvent.click(radio("Custom range"));
    expect(view.dates).toEqual({ kind: "custom", from: "2026-09-01", to: "2026-09-30" });
    await page.getByLabelText("From").fill("2026-08-15");

    expect(view.dates).toEqual({ kind: "custom", from: "2026-08-15", to: "2026-09-30" });
  });

  it("starts a custom range from this month when every date was shown", async () => {
    await renderTable();
    await open("Date");

    await userEvent.click(radio("Custom range"));

    expect(view.dates).toEqual({ kind: "custom", from: "2026-10-01", to: "2026-10-31" });
  });
});

describe("the account menu", () => {
  it("lists every account, checked, under All accounts", async () => {
    await renderTable();

    await open("Account");

    expect(checkboxes()).toEqual(["All accounts", ...ACCOUNTS]);
    for (const name of ["All accounts", ...ACCOUNTS])
      await expect.element(checkbox(name)).toBeChecked();
  });

  it("hides an account unchecked, and shows All accounts partly checked", async () => {
    await renderTable();
    await open("Account");

    await userEvent.click(checkbox("Savings"));

    expect(view.hiddenAccounts).toEqual(new Set(["Savings"]));
    await expect.element(checkbox("All accounts")).toBePartiallyChecked();
    await expect.element(checkbox("All accounts")).toHaveAccessibleName(/2 of 3$/);
  });

  it("unchecks every account from All accounts, and checks them all again", async () => {
    await renderTable();
    await open("Account");

    await userEvent.click(checkbox("All accounts"));
    expect(view.hiddenAccounts).toEqual(new Set(ACCOUNTS));
    await expect.element(checkbox("Card")).not.toBeChecked();

    await userEvent.click(checkbox("All accounts"));
    expect(view.hiddenAccounts).toEqual(new Set());
  });

  it("checks every account from All accounts when some are unchecked", async () => {
    await renderTable();
    await open("Account");
    await userEvent.click(checkbox("Savings"));

    await userEvent.click(checkbox("All accounts"));

    expect(view.hiddenAccounts).toEqual(new Set());
  });

  it("keeps its width as the count comes and goes", async () => {
    await renderTable();
    await open("Account");
    const width = () => menu("Account").element().getBoundingClientRect().width;
    const before = width();

    await userEvent.click(checkbox("Savings"));

    expect(width()).toBe(before);
  });

  it("sorts A to Z", async () => {
    await renderTable();
    await open("Account");

    await userEvent.click(radio("A to Z"));

    expect(view.sort).toEqual({ column: "account", direction: "ascending" });
  });
});

describe("the counterparty menu", () => {
  it("only sorts", async () => {
    await renderTable();
    await open("Counterparty");

    await userEvent.click(radio("Z to A"));

    expect(view.sort).toEqual({ column: "counterparty", direction: "descending" });
    expect(page.getByRole("checkbox").query()).toBeNull();
  });
});

describe("the category menu", () => {
  it("lists each category's subcategories under it", async () => {
    await renderTable();

    await open("Category");

    expect(checkboxes()).toEqual(["All categories", "Food", "Dining out", "Groceries", "Rent"]);
  });

  it("lists (no category) when a transaction has none", async () => {
    await renderTable([transaction({ category: null })]);

    await open("Category");

    expect(checkboxes().at(-1)).toBe("(no category)");
    await userEvent.click(checkbox("\\(no category\\)"));
    expect(view.hiddenCategories).toEqual(new Set([null]));
  });

  it("lists (no subcategory) under a category a transaction is set to itself", async () => {
    await renderTable([transaction({ category: "food" })]);

    await open("Category");

    expect(checkboxes()).toEqual([
      "All categories",
      "Food",
      "Dining out",
      "Groceries",
      "(no subcategory)",
      "Rent",
    ]);
    await userEvent.click(checkbox("\\(no subcategory\\)"));
    expect(view.hiddenCategories).toEqual(new Set(["Food"]));
  });

  it("unchecks a category with everything under it", async () => {
    await renderTable();
    await open("Category");

    await userEvent.click(checkbox("Food"));

    expect(view.hiddenCategories).toEqual(new Set(["Food", "Dining out", "Groceries"]));
    await expect.element(checkbox("Groceries")).not.toBeChecked();
  });

  it("shows a category partly checked when some of its subcategories are", async () => {
    await renderTable();
    await open("Category");

    await userEvent.click(checkbox("Groceries"));

    await expect.element(checkbox("Food")).toBePartiallyChecked();
    await expect.element(checkbox("All categories")).toHaveAccessibleName(/2 of 3$/);
  });

  describe("a category with one item under it", () => {
    const HEALTH: CategoryParent[] = [
      { name: "Health", parent: null },
      { name: "Pharmacy", parent: "Health" },
      { name: "Rent", parent: null },
    ];

    it("is that item, named after both", async () => {
      await render(<Table rows={[transaction({ category: "Pharmacy" })]} categories={HEALTH} />);

      await open("Category");

      expect(checkboxes()).toEqual(["All categories", "Health / Pharmacy", "Rent"]);
    });

    it("unchecks both with it", async () => {
      await render(<Table rows={[transaction({ category: "Pharmacy" })]} categories={HEALTH} />);
      await open("Category");

      await userEvent.click(checkbox("Health / Pharmacy"));

      expect(view.hiddenCategories).toEqual(new Set(["Health", "Pharmacy"]));
      await expect.element(checkbox("All categories")).toHaveAccessibleName(/1 of 2$/);
    });

    it("isn't, when transactions set to the category itself are listed under it too", async () => {
      await render(<Table rows={[transaction({ category: "Health" })]} categories={HEALTH} />);

      await open("Category");

      expect(checkboxes()).toEqual([
        "All categories",
        "Health",
        "Pharmacy",
        "(no subcategory)",
        "Rent",
      ]);
    });

    it("is one item for a chain of them", async () => {
      await render(
        <Table
          rows={[transaction({ category: "Prescriptions" })]}
          categories={[...HEALTH, { name: "Prescriptions", parent: "Pharmacy" }]}
        />,
      );

      await open("Category");

      expect(checkboxes()).toEqual(["All categories", "Health / Pharmacy / Prescriptions", "Rent"]);
    });

    it("keeps the subcategories of the one under it", async () => {
      await render(
        <Table
          rows={[transaction({ category: "Prescriptions" })]}
          categories={[
            ...HEALTH,
            { name: "Prescriptions", parent: "Pharmacy" },
            { name: "Vitamins", parent: "Pharmacy" },
          ]}
        />,
      );
      await open("Category");

      expect(checkboxes()).toEqual([
        "All categories",
        "Health / Pharmacy",
        "Prescriptions",
        "Vitamins",
        "Rent",
      ]);
      await userEvent.click(checkbox("Health / Pharmacy"));
      expect(view.hiddenCategories).toEqual(
        new Set(["Health", "Pharmacy", "Prescriptions", "Vitamins"]),
      );
    });
  });

  it("sorts A to Z", async () => {
    await renderTable();
    await open("Category");

    await userEvent.click(radio("A to Z"));

    expect(view.sort).toEqual({ column: "category", direction: "ascending" });
  });
});

describe("the amount menu", () => {
  it("shows only money in, or out", async () => {
    await renderTable();
    await open("Amount");
    await expect.element(radio("Show all")).toBeChecked();

    await userEvent.click(radio("Money out"));

    expect(view.flow).toBe("out");
  });

  it("lists the currencies the transactions are in", async () => {
    await renderTable([transaction({ currency: "USD" }), transaction({ currency: "EUR" })]);
    await open("Amount");

    expect(checkboxes()).toEqual(["All currencies", "EUR", "USD"]);
    await userEvent.click(checkbox("EUR"));

    expect(view.hiddenCurrencies).toEqual(new Set(["EUR"]));
  });

  it("doesn't sort", async () => {
    await renderTable();

    await open("Amount");

    expect(page.getByRole("group", { name: "Sort" }).query()).toBeNull();
  });
});
