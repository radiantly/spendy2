import { beforeEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { AccountCurrency, ListedTransaction } from "../../db/queries/transactions.ts";
import TransactionsList, { DAY_HEIGHT, ROW_HEIGHT } from "./TransactionsList.tsx";

const ACCOUNTS: AccountCurrency[] = [
  { name: "Everyday Checking", display_currency: "USD" },
  { name: "Travel Card", display_currency: "EUR" },
  { name: "Global Brokerage", display_currency: null },
];

let ids = 0;
function transaction(overrides: Partial<ListedTransaction> = {}): ListedTransaction {
  ids++;
  return {
    id: `t${ids}`,
    timestamp: null,
    sort_key: ids,
    naive_date: "2020-10-10",
    account_name: "Everyday Checking",
    counterparty: "Aldi",
    category: "Groceries",
    amount: -9474,
    decimals: 2,
    currency: "USD",
    remarks: null,
    transfer_account: null,
    duplicate_of: null,
    conversions: {},
    ...overrides,
  };
}

const show = (transactions: ListedTransaction[], accounts = ACCOUNTS) =>
  render(<TransactionsList transactions={transactions} accounts={accounts} />);

const items = () => page.getByRole("list", { name: "Transactions" }).getByRole("listitem");
const texts = () =>
  items()
    .elements()
    .map((item) => item.textContent);
/** The one transaction's item (the first is its day's heading). */
const only = () => items().nth(1);

/** The colour a Tailwind text colour class gives. */
function colorOfClass(className: string) {
  const probe = document.createElement("span");
  probe.className = className;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}
const colorOf = (text: string) =>
  getComputedStyle(only().getByText(text, { exact: true }).element()).color;

beforeEach(async () => {
  await page.viewport(390, 800);
});

describe("TransactionsList", () => {
  it("puts the transactions under a heading for each day, newest first, however they come", async () => {
    await show([
      transaction({ counterparty: "Uniqlo", naive_date: "2020-10-09", sort_key: 1 }),
      transaction({ counterparty: "Aldi", naive_date: "2020-10-10" }),
      transaction({ counterparty: "City Power", naive_date: "2020-10-09", sort_key: 2 }),
    ]);

    await expect.element(items().first()).toBeVisible();
    expect(texts()).toEqual([
      "Oct 10, 2020 Saturday",
      expect.stringContaining("Aldi"),
      "Oct 9, 2020 Friday",
      expect.stringContaining("City Power"),
      expect.stringContaining("Uniqlo"),
    ]);
    await expect
      .element(page.getByRole("heading", { level: 2, name: "Oct 10, 2020 Saturday" }))
      .toBeVisible();
  });

  it("sets a day's date and weekday on one baseline", async () => {
    await show([transaction({ naive_date: "2020-10-09" })]);
    const weekday = page.getByText("Friday", { exact: true }).element();

    // An empty inline block sits on the baseline of the text it's in.
    const baselineIn = (parent: Element, before: Node | null = null) => {
      const probe = document.createElement("span");
      probe.style.display = "inline-block";
      parent.insertBefore(probe, before);
      return probe.getBoundingClientRect().bottom;
    };
    expect(baselineIn(weekday.parentElement!, weekday)).toBe(baselineIn(weekday));
  });

  it("leaves the year out of this year's days", async () => {
    await show([transaction({ naive_date: `${new Date().getFullYear()}-03-15` })]);

    await expect
      .element(page.getByRole("heading", { level: 2 }))
      .toMatchTextContent(/^Mar 15 \w+day$/);
  });

  it("shows the counterparty's initial, its category and account, and the amount", async () => {
    await show([transaction({ counterparty: "aldi süd" })]);

    await expect.element(only()).toHaveTextContent("Aaldi südGroceries · Everyday Checking$94.74");
  });

  it("shows money in with a plus, in green", async () => {
    await show([transaction({ amount: 325049, counterparty: "Acme Corp Payroll" })]);

    await expect.element(only()).toMatchTextContent("+$3,250.49");
    expect(colorOf("+$3,250.49")).toBe(colorOfClass("text-gain"));
  });

  it("shows zero, where the table shows nothing", async () => {
    await show([transaction({ amount: 0 })]);

    await expect.element(only()).toMatchTextContent(/Everyday Checking\$0\.00$/);
  });

  it("says Uncategorized in red where the category would be", async () => {
    await show([transaction({ category: null })]);

    await expect.element(only()).toMatchTextContent("Uncategorized · Everyday Checking");
    expect(colorOf("Uncategorized")).toBe(colorOfClass("text-danger"));
  });

  it.each([
    ["a transfer", { transfer_account: "Savings", category: null }, "Transfer"],
    ["a duplicate", { duplicate_of: "t0" }, "Duplicate"],
    ["a duplicate transfer", { duplicate_of: "t0", transfer_account: "Savings" }, "Duplicate"],
  ])("says what %s is where the category would be", async (_name, overrides, text) => {
    await show([transaction(overrides)]);

    await expect.element(only()).toMatchTextContent(`${text} · Everyday Checking`);
  });

  it("shows the amount in its account's currency when it's in another, muted", async () => {
    await show([
      transaction({
        account_name: "Travel Card",
        amount: -1000,
        decimals: 2,
        conversions: { INR: { amount: -83000, decimals: 2 }, EUR: { amount: -920, decimals: 2 } },
      }),
    ]);

    await expect.element(only()).toMatchTextContent(/\$10\.00\s*€9\.20$/);
    expect(colorOf("€9.20")).toBe(colorOfClass("text-ink-muted"));
  });

  it("says when it has no amount in its account's currency", async () => {
    await show([
      transaction({
        account_name: "Travel Card",
        conversions: { INR: { amount: -83000, decimals: 2 } },
      }),
    ]);

    await expect.element(only()).toMatchTextContent(/\$94\.74\s*Not converted$/);
    expect(colorOf("Not converted")).toBe(colorOfClass("text-warning"));
  });

  it.each([
    ["in its account's currency", { account_name: "Travel Card", currency: "EUR" }, /€94\.74$/],
    ["in an account without a display currency", { account_name: "Global Brokerage" }, /\$94\.74$/],
  ])("shows just the amount for one %s", async (_name, overrides, amount) => {
    await show([
      transaction({ ...overrides, conversions: { GBP: { amount: -7500, decimals: 2 } } }),
    ]);

    await expect.element(only()).toMatchTextContent(amount);
  });

  it("finds the account ignoring case", async () => {
    await show([
      transaction({
        account_name: "travel card",
        conversions: { EUR: { amount: -8700, decimals: 2 } },
      }),
    ]);

    await expect.element(only()).toMatchTextContent(/€87\.00$/);
  });

  it("renders only the items near the viewport", async () => {
    const days = Array.from({ length: 2000 }, (_, day) =>
      [0, 1, 2, 3, 4].map(() =>
        transaction({
          naive_date: new Date(Date.UTC(2020, 0, 1) - day * 86_400_000).toISOString().slice(0, 10),
        }),
      ),
    );
    await show(days.flat());

    await expect.element(items().first()).toBeVisible();
    expect(items().elements().length).toBeLessThan(60);
    expect(page.getByRole("list", { name: "Transactions" }).element().clientHeight).toBe(
      2000 * DAY_HEIGHT + 10_000 * ROW_HEIGHT,
    );
  });
});
