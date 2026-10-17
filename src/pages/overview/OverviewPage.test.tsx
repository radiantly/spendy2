import { beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent, type Locator } from "vitest/browser";
import { downloadDatabase, downloadDatabaseIfChanged, uploadDatabase } from "../../api/database.ts";
import { renderApp } from "../../test/renderAuthPage.tsx";
import { rect } from "../../test/renderAuthPage.tsx";
import { SOURCE_HASH_SQL, transactionId } from "../../test/fixtures.ts";
import { holdNext } from "../../test/holdNext.ts";
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
  extra: {
    currency?: string;
    /** The amount in other currencies. */
    conversions?: Record<string, number>;
    transfer?: string;
    duplicateOf?: string;
  } = {},
) => `
  INSERT INTO transactions (seq, id, source, account_name, transfer_account, amount_numerator,
    amount_denominator, currency, counterparty, category, duplicate_of, naive_date)
  VALUES (${seq}, '${transactionId(seq)}', ${SOURCE_HASH_SQL}, '${account}', ${extra.transfer ? `'${extra.transfer}'` : "NULL"},
    ${Math.round(amount * 100)}, 100, '${extra.currency ?? "USD"}',
    '${counterparty}', ${category === null ? "NULL" : `'${category}'`},
    ${extra.duplicateOf ? `'${extra.duplicateOf}'` : "NULL"}, '${date}')
  ${Object.entries(extra.conversions ?? {})
    .map(
      ([currency, value]) =>
        `; INSERT INTO conversions VALUES ('${transactionId(seq)}', '${currency}', ${Math.round(value * 100)}, 100)`,
    )
    .join("")}
`;

/** Today is Oct 9, 2026 (see the mock of period.ts). */
const DATA = [
  `INSERT INTO accounts VALUES ('Everyday Checking', 'USD', 'Bank', '••4821'),
    ('Rewards Card', 'USD', 'Card', '••3307'), ('Travel Card', 'EUR', 'Card', '••5512'),
    ('Savings', 'USD', 'Bank', '••1190'), ('India Savings', 'INR', 'Bank', NULL)`,
  `INSERT INTO sources (hash, remarks, import_timestamp) VALUES (${SOURCE_HASH_SQL}, 'statement.csv', 1791374400)`,
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
    conversions: { USD: -26.4 },
  }),
  insert(9, "2026-10-07", "Rewards Card", -32, "SQ *KINDLING", null),
  insert(10, "2026-10-07", "Rewards Card", -18.4, "Café Lumen", "Dining out"),
  insert(11, "2026-10-08", "Everyday Checking", -300, "Transfer to Savings", null, {
    transfer: "Savings",
  }),
  insert(12, "2026-10-08", "Rewards Card", -18.4, "Café Lumen", "Dining out", {
    duplicateOf: transactionId(10),
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
const colorOf = (locator: Locator) => getComputedStyle(locator.element()).color;
/** What `color` (any CSS colour) computes to as a background. */
function backgroundOf(color: string) {
  const probe = document.createElement("span");
  probe.style.backgroundColor = color;
  document.body.append(probe);
  const computed = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return computed;
}
/** The colour a Tailwind text colour class gives. */
function colorOfClass(className: string) {
  const probe = document.createElement("span");
  probe.className = className;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}
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
    it("adds up spending in the currency's accounts, leaving out transfers and duplicates", async () => {
      await opened();

      // Rent 1,300 + groceries 46.20 + 32 + 18.40. Café Sol is on the card shown in EUR.
      await expect.element(region("Spent")).toMatchTextContent(/SPENT · OCTOBER\s*\$1,397/i);
    });

    it("compares with the same days last month", async () => {
      await opened();

      // Sep 1 – 9: 1,500.
      await expect.element(region("Spent")).toMatchTextContent(range("down 7%vs Sep 1 – 9"));
    });

    it("names the biggest categories", async () => {
      await opened();

      const top = region("Spent").getByRole("listitem");
      await expect.element(top.nth(0)).toMatchTextContent("Housing$1,300");
      await expect.element(top.nth(1)).toMatchTextContent("Food$65");
      expect(top.elements()).toHaveLength(2);
    });

    it("charts the spending adding up over the period", async () => {
      await opened();

      await expect
        .element(region("Spent").getByRole("img"))
        .toHaveAccessibleName("Spending added up from Oct 1, 2026 to Oct 9, 2026, reaching $1,397");
    });
  });

  it("shows money in against money out", async () => {
    await opened();

    await expect.element(region("Cash flow")).toMatchTextContent(/Money in\s*\$2,560/);
    await expect.element(region("Cash flow")).toMatchTextContent(/Money out\s*\$1,397/);
    await expect
      .element(region("Cash flow"))
      .toMatchTextContent("You spent 55% of what came in. +$1,163 net.");
  });

  describe("transactions overview", () => {
    const card = () => region("Transactions overview");
    /** The number shown above `label` in the card. */
    const count = (label: string) =>
      card().getByText(label, { exact: true }).element().nextElementSibling!.textContent;

    it("counts the uncategorized, and else those in other currencies", async () => {
      await opened();

      await expect
        .element(card())
        .toMatchTextContent(/^Transactions overviewuncategorized1foreign currency spends0See/);
      await expect
        .element(card().getByRole("link", { name: "See transactions →" }))
        .toHaveAttribute("href", "/transactions");
    });

    it("counts the transactions when none are uncategorized", async () => {
      await opened(
        [
          DATA,
          insert(15, "2026-10-02", "Travel Card", -10, "Airport Taxi", "Dining out", {
            conversions: { EUR: -9.2 },
          }),
        ].join(";"),
      );

      await userEvent.selectOptions(page.getByRole("combobox", { name: "Currency" }), "EUR");

      // Café Sol, and Airport Taxi in USD.
      await expect
        .element(card())
        .toMatchTextContent(/^Transactions overviewtransactions2foreign currency spends1See/);
    });

    it("counts as not converted those in accounts shown in the currency picked", async () => {
      await opened(
        [
          DATA,
          insert(15, "2026-10-02", "Rewards Card", -10, "London Cab", "Dining out", {
            currency: "GBP",
          }),
          insert(16, "2026-10-02", "Travel Card", -20, "London Pub", "Dining out", {
            currency: "GBP",
          }),
          insert(17, "2026-10-02", "Travel Card", -30, "Paris Cab", "Dining out", {
            currency: "GBP",
            conversions: { EUR: -35 },
          }),
        ].join(";"),
      );
      await expect.element(card()).toMatchTextContent("uncategorized1not converted1");

      await userEvent.selectOptions(page.getByRole("combobox", { name: "Currency" }), "EUR");

      // Café Sol's 24 and Paris Cab's 35; London Pub isn't converted.
      await expect.element(region("Spent")).toMatchTextContent("€59");
      expect(count("transactions")).toBe("3");
      expect(count("not converted")).toBe("1");
    });
  });

  describe("where it went", () => {
    it("lists spending by top-level category, most first, uncategorized last", async () => {
      await opened();

      const rows = region("Where it went").getByRole("listitem");
      await expect.element(rows.nth(0)).toMatchTextContent(/Housing.*93%\$1,300/);
      await expect.element(rows.nth(1)).toMatchTextContent(/Food.*5%\$65/);
      await expect.element(rows.nth(2)).toMatchTextContent(/Uncategorized2%\$32/);
    });

    it("keeps the bars inside the card when more went uncategorized than anywhere", async () => {
      await opened(
        [DATA, insert(15, "2026-10-02", "Rewards Card", -2000, "Mystery Shop", null)].join(";"),
      );
      const card = region("Where it went");
      await expect.element(card).toMatchTextContent(/Uncategorized.*\$2,032/);

      const { right } = card.element().getBoundingClientRect();
      for (const element of card.element().querySelectorAll("*"))
        expect(element.getBoundingClientRect().right).toBeLessThanOrEqual(right);
    });

    it("opens a category into its subcategories", async () => {
      await opened();
      const food = region("Where it went").getByRole("button", { name: /Food/ });
      await expect.element(food).toHaveAttribute("aria-expanded", "false");

      await userEvent.click(food);

      await expect.element(food).toHaveAttribute("aria-expanded", "true");
      const subs = region("Where it went").getByRole("list").nth(1).getByRole("listitem");
      await expect.element(subs.nth(0)).toMatchTextContent("Groceries$46");
      await expect.element(subs.nth(1)).toMatchTextContent("Dining out$18");
    });
  });

  it("lists every account, busiest first, in its own currency", async () => {
    await opened();

    const accounts = region("Accounts").getByRole("listitem");
    await expect.element(accounts.nth(0)).toHaveTextContent("Rewards Card[Card] ••3307In$0Out-$97");
    // Transfers are left out.
    await expect
      .element(accounts.nth(1))
      .toHaveTextContent("Everyday Checking[Bank] ••4821In+$2,560Out-$1,300");
    await expect.element(accounts.nth(2)).toMatchTextContent(/^India Savings.*Out-₹5,000$/);
    await expect.element(accounts.nth(3)).toMatchTextContent(/^Travel Card.*Out-€24$/);
    await expect.element(accounts.nth(4)).toHaveTextContent("Savings[Bank] ••1190In$0Out$0");
  });

  it("counts other currencies in an account's own through their conversions", async () => {
    await opened(
      [
        DATA,
        insert(15, "2026-10-02", "Travel Card", -10, "Airport Taxi", "Dining out", {
          conversions: { EUR: -9.2 },
        }),
      ].join(";"),
    );

    await expect.element(region("Accounts")).toMatchTextContent(/Travel Card.*Out-€33/);
  });

  it("says an account without a display currency has several", async () => {
    await opened(
      [
        DATA,
        `INSERT INTO accounts VALUES ('Wallet', NULL, 'Cash', NULL)`,
        insert(15, "2026-10-02", "Wallet", -10, "Kiosk", "Dining out"),
      ].join(";"),
    );

    await expect
      .element(region("Accounts").getByRole("listitem").filter({ hasText: "Wallet" }))
      .toHaveTextContent("Wallet[Cash]Multiple currencies");
  });

  it("shows each account's type and identifier, or just its type without one", async () => {
    await opened();

    const accounts = region("Accounts");
    await expect.element(accounts.getByText("[Card] ••3307")).toBeVisible();
    await expect.element(accounts.getByText("[Bank]", { exact: true })).toBeVisible();
  });

  it("marks every account with a bar in the field colour", async () => {
    await opened();

    const accounts = region("Accounts").getByRole("listitem");
    await expect.element(accounts.nth(0)).toBeVisible();
    const bars = accounts.all().map((account) => account.element().firstElementChild!);
    expect(bars.map((bar) => getComputedStyle(bar).backgroundColor)).toEqual(
      Array(5).fill(backgroundOf("var(--color-field)")),
    );
  });

  it("shows money in green, money out in red, and none in grey", async () => {
    await opened();

    const checking = region("Accounts").getByRole("listitem").nth(1);
    const savings = region("Accounts").getByRole("listitem").nth(4);
    await expect.element(checking).toBeVisible();
    expect(colorOf(checking.getByText("+$2,560"))).toBe(colorOfClass("text-gain"));
    expect(colorOf(checking.getByText("-$1,300"))).toBe(colorOfClass("text-danger"));
    const zeros = savings.getByText("$0").all();
    expect(zeros).toHaveLength(2);
    for (const zero of zeros) expect(colorOf(zero)).toBe(colorOfClass("text-ink-muted"));
  });

  describe("recent", () => {
    it("lists the period's latest transactions, newest first", async () => {
      await opened();

      const rows = region("Recent").getByRole("listitem");
      expect(rows.elements().map((row) => row.querySelector(".truncate")?.textContent)).toEqual([
        "Café Lumen",
        "Transfer to Savings",
        "Café Lumen",
        "SQ *KINDLING",
        "Corner Market",
        "Acme Corp Payroll",
        "Parkside Apartments",
      ]);
    });

    it("labels each with its category, account and amount", async () => {
      await opened();

      const rows = region("Recent").getByRole("listitem");
      await expect
        .element(rows.nth(0))
        .toMatchTextContent(
          /Oct 8Café LumenFood › Dining outRewards CardMarked as duplicate-\$18\.40/,
        );
      await expect.element(rows.nth(1)).toMatchTextContent(/TransferEveryday Checking-\$300\.00/);
      await expect.element(rows.nth(3)).toMatchTextContent(/UncategorizedRewards Card/);
    });

    it("shows an amount in another currency with its conversion", async () => {
      await opened(
        [
          DATA,
          insert(15, "2026-10-09", "Rewards Card", -20, "Bistro Paris", "Dining out", {
            currency: "EUR",
            conversions: { USD: -21.8 },
          }),
        ].join(";"),
      );

      await expect
        .element(region("Recent").getByRole("listitem").nth(0))
        .toMatchTextContent(/Bistro Paris.*-€20\.00≈ -\$21\.80/);
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
      .toMatchTextContent("Oct 2026: income $2,560, spending $1,397 (in the selected period)");
  });

  it("notes the currency amounts are in", async () => {
    await opened();

    await expect
      .element(page.getByText(/^Decrypted locally/))
      .toHaveTextContent(
        "Decrypted locally · last import Oct 7, 2026 · amounts in USD, converted where noted",
      );
  });

  describe("choosing a currency", () => {
    const currency = () => region("Spent").getByRole("combobox", { name: "Currency" });

    it("lists the currencies on the Spent card, the most used first, starting on it", async () => {
      await opened();

      await expect.element(currency()).toHaveValue("USD");
      expect(
        currency()
          .getByRole("option")
          .elements()
          .map((option) => option.textContent),
      ).toEqual(["USD", "EUR", "INR"]);
    });

    it("shows the transactions of the currency picked, in it", async () => {
      await opened(
        [
          DATA,
          insert(15, "2026-10-02", "Travel Card", -10, "Airport Taxi", "Dining out", {
            conversions: { EUR: -9.2 },
          }),
        ].join(";"),
      );

      await userEvent.selectOptions(currency(), "EUR");

      // Café Sol's 24, and Airport Taxi's 9.20 converted.
      await expect.element(region("Spent")).toMatchTextContent(/SPENT · OCTOBER\s*€33/i);
      const recent = region("Recent").getByRole("listitem");
      await expect.element(recent.nth(0)).toMatchTextContent(/Café Sol.*-€24\.00$/);
      await expect.element(recent.nth(1)).toMatchTextContent(/Airport Taxi.*-\$10\.00≈ -€9\.20$/);
      expect(recent.elements()).toHaveLength(2);
      await expect
        .element(page.getByText(/^Decrypted locally/))
        .toMatchTextContent("amounts in EUR, converted where noted");
    });

    it("shows the currency picked while its overview loads", async () => {
      await opened();
      const load = holdNext(
        "query",
        (_sql, bind) => (bind as { $display?: string } | undefined)?.$display === "EUR",
      );

      await userEvent.selectOptions(currency(), "EUR");

      await expect.element(currency()).toHaveValue("EUR");
      // Still the USD overview: it's loading.
      await expect.element(region("Spent")).toMatchTextContent("$1,397");
      await load.release();
      await expect.element(region("Spent")).toMatchTextContent("€24");
      await expect.element(currency()).toHaveValue("EUR");
    });

    it("keeps the currency picked for another period", async () => {
      await opened();
      await userEvent.selectOptions(currency(), "EUR");
      await expect.element(region("Spent")).toMatchTextContent("€24");

      await userEvent.click(page.getByRole("button", { name: "Last month" }));

      await expect.element(region("Spent")).toMatchTextContent(/SPENT · SEPTEMBER\s*€0/i);
      await expect.element(currency()).toHaveValue("EUR");
    });

    it("is there when there's nothing to compare with", async () => {
      await opened();

      await userEvent.click(page.getByRole("button", { name: "All" }));

      await expect.element(region("Spent")).toMatchTextContent(/SPENT · ALL TIME/i);
      await expect.element(currency()).toHaveValue("USD");
    });

    it("goes back to the most used once the one picked has no amounts", async () => {
      await opened();
      await userEvent.selectOptions(currency(), "INR");
      await expect.element(region("Spent")).toMatchTextContent("₹5,000");
      const newer = await storedDatabase(
        `${DATA}; DELETE FROM transactions WHERE currency = 'INR'`,
      );
      vi.mocked(downloadDatabaseIfChanged).mockResolvedValue({
        success: true,
        blob: newer,
        sha256: "c".repeat(64),
      });

      document.dispatchEvent(new Event("visibilitychange"));

      await expect.element(region("Spent")).toMatchTextContent("$1,397");
      await expect.element(currency()).toHaveValue("USD");
    });
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
      await expect.element(region("Spent")).toMatchTextContent(/SPENT · ALL TIME\s*\$4,187/i);
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
      await expect.element(region("Spent")).toMatchTextContent(/\$2,947/);
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
        "Transactions overview",
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
    await expect.element(region("Spent")).toMatchTextContent("$1,397");
    const newer = await storedDatabase(`${DATA}; DELETE FROM transactions WHERE category = 'Rent'`);
    vi.mocked(downloadDatabaseIfChanged).mockResolvedValue({
      success: true,
      blob: newer,
      sha256: "c".repeat(64),
    });

    document.dispatchEvent(new Event("visibilitychange"));

    await expect.element(region("Spent")).toMatchTextContent("$97");
  });
});
