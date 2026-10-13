import { beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { downloadDatabase, downloadDatabaseIfChanged, uploadDatabase } from "../../api/database.ts";
import { renderApp } from "../../test/renderAuthPage.tsx";
import { rect } from "../../test/renderAuthPage.tsx";
import { loggedIn, storedDatabase } from "../../test/storedDatabase.ts";

vi.mock("../../api/database.ts", () => ({
  downloadDatabase: vi.fn(),
  downloadDatabaseIfChanged: vi.fn(),
  uploadDatabase: vi.fn(),
}));
// A fixed today; faking Date itself stops expect.element's retries.
vi.mock("./period.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./period.ts")>()),
  today: () => "2026-10-09",
}));

const insert = (
  seq: number,
  date: string,
  account: string,
  amount: number,
  counterparty: string,
  category: string | null,
  extra: { currency?: string; converted?: number; transfer?: string; duplicateOf?: string } = {},
) => `
  INSERT INTO transactions (seq, id, source, account_name, transfer_account, amount, currency,
    converted_amount, converted_currency, counterparty, category, duplicate_of, naive_date)
  VALUES (${seq}, 't${seq}', 's', '${account}', ${extra.transfer ? `'${extra.transfer}'` : "NULL"},
    ${Math.round(amount * 10_000)}, '${extra.currency ?? "USD"}',
    ${extra.converted === undefined ? "NULL, NULL" : `${Math.round(extra.converted * 10_000)}, 'USD'`},
    '${counterparty}', ${category === null ? "NULL" : `'${category}'`},
    ${extra.duplicateOf ? `'${extra.duplicateOf}'` : "NULL"}, '${date}')
`;

/** Today is Oct 9, 2026 (see the mock of period.ts). */
const DATA = [
  `INSERT INTO accounts VALUES ('Everyday Checking', 'USD'), ('Rewards Card', 'USD'),
    ('Travel Card', 'EUR'), ('Savings', 'USD'), ('India Savings', 'INR')`,
  `INSERT INTO sources (hash, remarks, import_timestamp) VALUES ('s', 'statement.csv', 1791374400)`,
  `INSERT INTO categories VALUES ('Food', NULL), ('Groceries', 'Food'), ('Dining out', 'Food'),
    ('Housing', NULL), ('Rent', 'Housing'), ('Health', NULL), ('Income', NULL), ('Salary', 'Income')`,
  insert(1, "2026-08-03", "Everyday Checking", 2560, "Acme Corp Payroll", "Salary"),
  insert(14, "2026-08-20", "Rewards Card", -1240, "Corner Market", "Groceries"),
  insert(2, "2026-09-02", "Everyday Checking", -1300, "Parkside Apartments", "Rent"),
  insert(3, "2026-09-05", "Rewards Card", -200, "Corner Market", "Groceries"),
  insert(4, "2026-09-20", "Rewards Card", -50, "Noodle Bar", "Dining out"),
  insert(5, "2026-10-01", "Everyday Checking", -1300, "Parkside Apartments", "Rent"),
  insert(6, "2026-10-03", "Everyday Checking", 2560, "Acme Corp Payroll", "Salary"),
  insert(7, "2026-10-04", "Rewards Card", -46.2, "Corner Market", "Groceries"),
  insert(8, "2026-10-06", "Travel Card", -24, "Café Sol", "Dining out", {
    currency: "EUR",
    converted: -26.4,
  }),
  insert(9, "2026-10-07", "Rewards Card", -32, "SQ *KINDLING", null),
  insert(10, "2026-10-07", "Rewards Card", -18.4, "Café Lumen", "Dining out"),
  insert(11, "2026-10-08", "Everyday Checking", -300, "Transfer to Savings", null, {
    transfer: "Savings",
  }),
  insert(12, "2026-10-08", "Rewards Card", -18.4, "Café Lumen", "Dining out", {
    duplicateOf: "t10",
  }),
  insert(13, "2026-10-09", "India Savings", -5000, "Apollo Pharmacy", "Health", {
    currency: "INR",
  }),
].join(";");

beforeEach(async () => {
  vi.mocked(downloadDatabase).mockReset();
  vi.mocked(uploadDatabase).mockReset();
  vi.mocked(downloadDatabaseIfChanged).mockReset();
  vi.mocked(downloadDatabaseIfChanged).mockResolvedValue({ success: false, code: "NOT_MODIFIED" });
  await page.viewport(1400, 1000);
});

async function opened(sql = DATA) {
  await loggedIn(await storedDatabase(sql));
  const app = await renderApp("/");
  await expect.element(page.getByRole("heading", { level: 1 })).toBeVisible();
  return app;
}

const region = (name: string) => page.getByRole("region", { name });
// Intl puts thin spaces around the dash in date ranges.
const range = (text: string) => new RegExp(text.replaceAll(" – ", "\\s–\\s"));

describe("OverviewPage", () => {
  it("shows this month so far", async () => {
    await opened();

    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toMatchTextContent(range("Oct 1 – 9, 2026"));
    await expect
      .element(page.getByRole("button", { name: "This month" }))
      .toHaveAttribute("aria-pressed", "true");
  });

  it("says there's nothing to show without transactions", async () => {
    await loggedIn(null);
    await renderApp("/");

    await expect.element(page.getByText("No transactions yet.")).toBeVisible();
  });

  describe("spent", () => {
    it("adds up spending, leaving out transfers, duplicates and other currencies", async () => {
      await opened();

      // Rent 1,300 + groceries 46.20 + converted 26.40 + 32 + 18.40.
      await expect.element(region("Spent")).toMatchTextContent(/SPENT · OCTOBER\s*\$1,423/i);
    });

    it("compares with the same days last month", async () => {
      await opened();

      // Sep 1 – 9: 1,500.
      await expect.element(region("Spent")).toMatchTextContent(range("down 5%vs Sep 1 – 9"));
    });

    it("names the biggest categories", async () => {
      await opened();

      const top = region("Spent").getByRole("listitem");
      await expect.element(top.nth(0)).toMatchTextContent("Housing$1,300");
      await expect.element(top.nth(1)).toMatchTextContent("Food$91");
      expect(top.elements()).toHaveLength(2);
    });

    it("charts the spending adding up over the period", async () => {
      await opened();

      await expect
        .element(region("Spent").getByRole("img"))
        .toHaveAccessibleName("Spending added up from Oct 1, 2026 to Oct 9, 2026, reaching $1,423");
    });
  });

  it("shows money in against money out", async () => {
    await opened();

    await expect.element(region("Cash flow")).toMatchTextContent(/Money in\s*\$2,560/);
    await expect.element(region("Cash flow")).toMatchTextContent(/Money out\s*\$1,423/);
    await expect
      .element(region("Cash flow"))
      .toMatchTextContent("You spent 56% of what came in. +$1,137 net.");
  });

  it("counts the transactions, and those without a category", async () => {
    await opened();

    const glance = region("At a glance");
    await expect.element(glance).toMatchTextContent(/^At a glancetransactions9uncategorized1See/);
    await expect
      .element(glance.getByRole("link", { name: "See transactions →" }))
      .toHaveAttribute("href", "/transactions");
  });

  describe("where it went", () => {
    it("lists spending by top-level category, most first, uncategorized last", async () => {
      await opened();

      const rows = region("Where it went").getByRole("listitem");
      await expect.element(rows.nth(0)).toMatchTextContent(/Housing.*91%\$1,300/);
      await expect.element(rows.nth(1)).toMatchTextContent(/Food.*6%\$91/);
      await expect.element(rows.nth(2)).toMatchTextContent(/Uncategorized2%\$32/);
    });

    it("opens a category into its subcategories", async () => {
      await opened();
      const food = region("Where it went").getByRole("button", { name: /Food/ });
      await expect.element(food).toHaveAttribute("aria-expanded", "false");

      await userEvent.click(food);

      await expect.element(food).toHaveAttribute("aria-expanded", "true");
      const subs = region("Where it went").getByRole("list").nth(1).getByRole("listitem");
      await expect.element(subs.nth(0)).toMatchTextContent("Groceries$46");
      await expect.element(subs.nth(1)).toMatchTextContent("Dining out$45");
    });
  });

  it("lists every account, busiest first, in its own currency", async () => {
    await opened();

    const accounts = region("Accounts").getByRole("listitem");
    await expect.element(accounts.nth(0)).toMatchTextContent(/Rewards Card.*4 txns/);
    await expect.element(accounts.nth(0)).toMatchTextContent(/Out\s*\$97/);
    await expect
      .element(accounts.nth(1))
      .toMatchTextContent(/Everyday Checking.*In\$2,560Out\$1,300Transfers-\$300/);
    await expect.element(accounts.nth(2)).toMatchTextContent(/India Savings.*Out₹5,000/);
    await expect.element(accounts.nth(3)).toMatchTextContent(/Travel Card.*Out€24/);
    await expect.element(accounts.nth(4)).toMatchTextContent(/Savings.*0 txns/);
  });

  describe("recent", () => {
    it("lists the period's latest transactions, newest first", async () => {
      await opened();

      const rows = region("Recent").getByRole("listitem");
      expect(rows.elements().map((row) => row.querySelector(".truncate")?.textContent)).toEqual([
        "Apollo Pharmacy",
        "Café Lumen",
        "Transfer to Savings",
        "Café Lumen",
        "SQ *KINDLING",
        "Café Sol",
        "Corner Market",
      ]);
    });

    it("labels each with its category, account and amount", async () => {
      await opened();

      const rows = region("Recent").getByRole("listitem");
      await expect
        .element(rows.nth(1))
        .toMatchTextContent(
          /Oct 8Café LumenFood › Dining outRewards CardMarked as duplicate-\$18\.40/,
        );
      await expect.element(rows.nth(2)).toMatchTextContent(/TransferEveryday Checking-\$300\.00/);
      await expect.element(rows.nth(4)).toMatchTextContent(/UncategorizedRewards Card/);
      await expect.element(rows.nth(5)).toMatchTextContent(/-€24\.00≈ -\$26\.40/);
    });

    it("links to all transactions", async () => {
      await opened();

      await expect
        .element(region("Recent").getByRole("link", { name: "All transactions →" }))
        .toHaveAttribute("href", "/transactions");
    });
  });

  it("charts income and spending for the last 8 months, marking the period's", async () => {
    await opened();

    const months = region("Income vs. spending").getByRole("listitem");
    expect(months.elements()).toHaveLength(8);
    await expect.element(months.nth(0)).toMatchTextContent("Mar 2026: income $0, spending $0");
    await expect
      .element(months.nth(5))
      .toMatchTextContent("Aug 2026: income $2,560, spending $1,240");
    await expect.element(months.nth(6)).toMatchTextContent("Sep 2026: income $0, spending $1,550");
    await expect
      .element(months.nth(7))
      .toMatchTextContent("Oct 2026: income $2,560, spending $1,423 (in the selected period)");
  });

  it("notes the base currency and what was left out", async () => {
    await opened();

    await expect
      .element(page.getByText(/^Decrypted locally/))
      .toMatchTextContent(
        "Decrypted locally · last import Oct 7, 2026 · amounts in USD, converted where noted · 1 in other currencies left out",
      );
  });

  describe("choosing a period", () => {
    it("shows last month instead", async () => {
      await opened();

      await userEvent.click(page.getByRole("button", { name: "Last month" }));

      await expect
        .element(page.getByRole("heading", { level: 1 }))
        .toMatchTextContent("September 2026");
      await expect.element(region("Spent")).toMatchTextContent(/SPENT · SEPTEMBER\s*\$1,550/i);
      // Against August's 1,240.
      await expect.element(region("Spent")).toMatchTextContent("up 25%vs August");
      await expect
        .element(page.getByRole("button", { name: "Last month" }))
        .toHaveAttribute("aria-pressed", "true");
    });

    it("shows everything, with nothing to compare", async () => {
      await opened();

      await userEvent.click(page.getByRole("button", { name: "All" }));

      await expect
        .element(page.getByRole("heading", { level: 1 }))
        .toMatchTextContent(range("Aug – Oct 2026"));
      await expect.element(region("Spent")).toMatchTextContent(/SPENT · ALL TIME\s*\$4,213/i);
      await expect.element(region("Spent")).not.toMatchTextContent("vs");
    });

    it("starts a custom range from the period shown, and changes it", async () => {
      await opened();

      await userEvent.click(page.getByRole("button", { name: "Custom" }));
      const from = page.getByLabelText("From");
      await expect.element(from).toHaveValue("2026-10-01");
      await expect.element(page.getByLabelText("To")).toHaveValue("2026-10-09");

      await userEvent.fill(from, "2026-09-01");

      await expect
        .element(page.getByRole("heading", { level: 1 }))
        .toMatchTextContent(range("Sep 1 – Oct 9, 2026"));
      await expect.element(region("Spent")).toMatchTextContent(/\$2,973/);
    });

    it("edits a custom range's dates where the heading was", async () => {
      await opened();
      const heading = rect(page.getByRole("heading", { level: 1 }));

      await userEvent.click(page.getByRole("button", { name: "Custom" }));

      const from = rect(page.getByLabelText("From"));
      const to = rect(page.getByLabelText("To"));
      expect(from.left).toBe(heading.left);
      expect(to.top).toBe(from.top);
      expect(to.left).toBeGreaterThan(from.right);
    });

    // On a phone the dates take two lines, so the page moves there.
    it("doesn't move the page when switching to and from a custom range", async () => {
      await opened();
      const before = rect(region("Spent")).top;

      await userEvent.click(page.getByRole("button", { name: "Custom" }));
      await expect.element(page.getByLabelText("From")).toBeVisible();
      expect(rect(region("Spent")).top).toBe(before);

      await userEvent.click(page.getByRole("button", { name: "This month" }));
      await expect.element(page.getByLabelText("From")).not.toBeInTheDocument();
      expect(rect(region("Spent")).top).toBe(before);
    });

    it("goes back to the heading for a preset", async () => {
      await opened();
      await userEvent.click(page.getByRole("button", { name: "Custom" }));
      await expect.element(page.getByLabelText("From")).toBeVisible();

      await userEvent.click(page.getByRole("button", { name: "Last month" }));

      expect(page.getByLabelText("From").query()).toBeNull();
      await expect
        .element(page.getByRole("heading", { level: 1 }))
        .toMatchTextContent("September 2026");
    });

    describe("on a narrow screen", () => {
      const dropdown = () => page.getByRole("combobox", { name: "Choose period" });

      it("is a dropdown", async () => {
        await page.viewport(767, 1000);
        await opened();

        await expect.element(dropdown()).toHaveValue("this-month");
        expect(page.getByRole("group", { name: "Choose period" }).query()).toBeNull();

        await userEvent.selectOptions(dropdown(), "Last month");

        await expect
          .element(page.getByRole("heading", { level: 1 }))
          .toMatchTextContent("September 2026");
      });

      it("starts a custom range from the period shown", async () => {
        await page.viewport(390, 1000);
        await opened();

        await userEvent.selectOptions(dropdown(), "Custom");

        await expect.element(page.getByLabelText("From")).toHaveValue("2026-10-01");
        await expect.element(page.getByLabelText("To")).toHaveValue("2026-10-09");
      });
    });

    it("is buttons in one row from 768px", async () => {
      await page.viewport(768, 1000);
      await opened();

      const buttons = page.getByRole("group", { name: "Choose period" }).getByRole("button");
      await expect.element(buttons.first()).toBeVisible();
      expect(
        new Set(buttons.elements().map((button) => button.getBoundingClientRect().top)).size,
      ).toBe(1);
      expect(page.getByRole("combobox", { name: "Choose period" }).query()).toBeNull();
    });
  });

  describe("layout", () => {
    const top = (name: string) => rect(region(name)).top;

    it("stacks two columns independently on a wide screen", async () => {
      await opened();
      await expect.element(region("Income vs. spending")).toBeVisible();

      const where = rect(region("Where it went"));
      const recent = rect(region("Recent"));
      const accounts = rect(region("Accounts"));
      const chart = rect(region("Income vs. spending"));
      // Recent in the wide column under Where it went, the chart in the narrow one.
      expect(recent.left).toBe(where.left);
      expect(recent.top).toBeGreaterThan(where.bottom);
      expect(chart.left).toBe(accounts.left);
      expect(chart.width).toBeLessThan(recent.width);
      // Straight after the accounts, however few there are.
      expect(chart.top - accounts.bottom).toBe(16);
    });

    it("stops growing at 1280px on a very wide screen, in the middle", async () => {
      await page.viewport(1920, 1000);
      await opened();
      await expect.element(region("Income vs. spending")).toBeVisible();

      // The cards span 1280px less the 32px padding each side.
      const left = rect(region("Spent")).left;
      const right = rect(region("Cash flow")).right;
      expect(right - left).toBe(1280 - 2 * 32);
      expect(left).toBe(document.documentElement.clientWidth - right);
    });

    it("interleaves the columns on a phone, within the screen", async () => {
      await page.viewport(390, 900);
      await opened();
      await expect.element(region("Income vs. spending")).toBeInTheDocument();

      const order = [
        "Spent",
        "Cash flow",
        "At a glance",
        "Where it went",
        "Accounts",
        "Recent",
        "Income vs. spending",
      ];
      const tops = order.map(top);
      expect(tops).toEqual([...tops].sort((a, b) => a - b));
      expect(document.documentElement.scrollWidth).toBe(390);
    });
  });

  it("shows a newer version saved elsewhere", async () => {
    await opened();
    await expect.element(region("Spent")).toMatchTextContent("$1,423");
    const newer = await storedDatabase(`${DATA}; DELETE FROM transactions WHERE category = 'Rent'`);
    vi.mocked(downloadDatabaseIfChanged).mockResolvedValue({
      success: true,
      blob: newer,
      sha256: "c".repeat(64),
    });

    document.dispatchEvent(new Event("visibilitychange"));

    await expect.element(region("Spent")).toMatchTextContent("$123");
  });
});
