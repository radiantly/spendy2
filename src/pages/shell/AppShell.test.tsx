import { beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { toast } from "sonner";
import { logoutUser } from "../../api/auth.ts";
import { downloadDatabase, downloadDatabaseIfChanged, uploadDatabase } from "../../api/database.ts";
import { Database, openDatabase } from "../../db/database.ts";
import { GET_OVERVIEW_META } from "../../db/queries/overview.ts";
import { LIST_CATEGORIES, LIST_TRANSACTIONS } from "../../db/queries/transactions.ts";
import { ClosedError } from "../../db/rpc.ts";
import { today } from "../../lib/period.ts";
import { loadSession } from "../../lib/session.ts";
import { itFailsInFirefox } from "../../test/browsers.ts";
import { nextDownload } from "../../test/download.ts";
import { SOURCE_HASH_SQL, TOKEN, transactionId } from "../../test/fixtures.ts";
import { holdNext } from "../../test/holdNext.ts";
import { rect, renderApp } from "../../test/renderAuthPage.tsx";
import { openSqliteFile } from "../../test/sqliteFile.ts";
import { loggedIn, SHA_A, SHA_B, session, storedDatabase } from "../../test/storedDatabase.ts";

vi.mock("../../api/database.ts", () => ({
  downloadDatabase: vi.fn(),
  downloadDatabaseIfChanged: vi.fn(),
  uploadDatabase: vi.fn(),
}));
vi.mock("../../api/auth.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/auth.ts")>()),
  logoutUser: vi.fn(),
}));

/** Opens an uploaded blob and runs a query on it. */
async function queryUploaded(blob: Uint8Array<ArrayBuffer>, sql: string) {
  vi.mocked(downloadDatabase).mockResolvedValueOnce({ success: true, blob, sha256: SHA_B });
  const db = await openDatabase(await session());
  try {
    return await db.query(sql);
  } finally {
    db.close();
  }
}

const [OLDER, NEWER] = [1, 2].map(transactionId);
const TWO_TRANSACTIONS = `
  INSERT INTO accounts VALUES ('Everyday Checking', 'USD', 'Bank', NULL);
  INSERT INTO accounts VALUES ('Savings', 'USD', 'Bank', NULL);
  INSERT INTO sources (hash, remarks) VALUES (${SOURCE_HASH_SQL}, 'statement.csv');
  INSERT INTO categories VALUES ('Groceries', NULL);
  INSERT INTO transactions (sort_key, id, source, account_name, amount, currency, counterparty, category, naive_date)
    VALUES (1, '${OLDER}', ${SOURCE_HASH_SQL}, 'Everyday Checking', -500, 'USD', 'Café Lumen', NULL, '2026-10-01');
  INSERT INTO transactions (sort_key, id, source, account_name, amount, currency, counterparty, category, naive_date)
    VALUES (2, '${NEWER}', ${SOURCE_HASH_SQL}, 'Everyday Checking', -4620, 'USD', 'Corner Market', 'Groceries', '2026-10-09')
`;
/** Corner Market's USD -46.20 is also EUR -42.10 and SGD -62.30. */
const WITH_CONVERSIONS = `${TWO_TRANSACTIONS};
  INSERT INTO conversions VALUES ('${NEWER}', 'EUR', -4210), ('${NEWER}', 'SGD', -6230)`;

beforeEach(async () => {
  vi.mocked(logoutUser).mockReset();
  vi.mocked(logoutUser).mockResolvedValue({ success: true });
  vi.mocked(downloadDatabase).mockReset();
  vi.mocked(uploadDatabase).mockReset();
  vi.mocked(uploadDatabase).mockResolvedValue({ success: true, sha256: SHA_B });
  vi.mocked(downloadDatabaseIfChanged).mockReset();
  vi.mocked(downloadDatabaseIfChanged).mockResolvedValue({ success: false, code: "NOT_MODIFIED" });
  await page.viewport(1280, 800);
});

const saveButton = () => page.getByRole("button", { name: /^(Save|Saving…)$/ });

const holdNextQuery = (match: (sql: string) => boolean) => holdNext("query", (sql) => match(sql));

/**
 * Holds back the next call of the database worker's `method` on its way to
 * the worker, until it's released: below `Database`, which has already
 * acted on the call by then.
 */
function holdNextWorkerCall(method: string) {
  const original = Worker.prototype.postMessage;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const spy = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
    this: Worker,
    ...args: Parameters<Worker["postMessage"]>
  ) {
    if ((args[0] as { method?: string }).method !== method)
      return original.apply(this, args as never);
    spy.mockRestore();
    void held.then(() => original.apply(this, args as never));
  });
  return { release };
}
/** Edits are written in a batch of statements. */
const holdNextUpdate = () =>
  holdNext("batch", (statements) =>
    statements.some(({ sql }) => sql.trimStart().startsWith("UPDATE")),
  );

const DATE = 0;
const ACCOUNT = 1;
const COUNTERPARTY = 2;
const CATEGORY = 3;
const AMOUNT = 4;
const REMARKS = 5;

/** The text of each row's cell in `column` (0-based), top to bottom. */
const columnTexts = (column: number) =>
  page
    .getByRole("row")
    .elements()
    .slice(1)
    .map((row) => row.querySelectorAll('[role="gridcell"]')[column]!.textContent);

/** The cell in `column` (0-based) of the row showing `text`, once it's shown. */
async function cellOf(text: string, column: number) {
  const cell = page.getByRole("row").filter({ hasText: text }).getByRole("gridcell").nth(column);
  await expect.element(cell).toBeVisible();
  return cell;
}

async function editCounterparty(from: string, to: string) {
  await userEvent.dblClick(page.getByText(from).shown());
  await page.getByRole("textbox").fill(to);
  await userEvent.keyboard("{Enter}");
}

/** The transactions as a list, on screens too narrow for the table. */
const list = () => page.getByRole("list", { name: "Transactions" });

/** The page checks for a newer version when it's shown again, as well as every 10 seconds. */
const checkForUpdates = () => document.dispatchEvent(new Event("visibilitychange"));

/** Logged in, with the transactions page open on TWO_TRANSACTIONS. */
async function opened() {
  await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
  const app = await renderApp("/transactions");
  await expect.element(page.getByText("Corner Market").shown()).toBeVisible();
  return app;
}

describe("AppShell", () => {
  it("sends anonymous visitors to the login page", async () => {
    const { router } = await renderApp("/transactions");

    await expect.poll(() => router.state.location.pathname).toBe("/login");
  });

  it("marks the current tab", async () => {
    await loggedIn(null);
    await renderApp("/transactions");

    await expect
      .element(page.getByRole("link", { name: "Transactions" }))
      .toHaveAttribute("aria-current", "page");
    await expect
      .element(page.getByRole("link", { name: "Overview" }))
      .not.toHaveAttribute("aria-current");
  });

  it.each([360, 390])(
    "keeps the header on one line on a %ipx phone, with the tabs in the middle",
    async (width) => {
      await page.viewport(width, 800);
      await loggedIn(null);
      await renderApp("/");
      const avatar = page.getByRole("img", { name: "Logged in as alice" });
      await expect.element(avatar).toBeVisible();

      const header = page.getByRole("banner").element();
      const [logo, tabs, user] = [
        header.firstElementChild!,
        page.getByRole("navigation", { name: "Main" }).element(),
        avatar.element(),
      ].map((element) => element.getBoundingClientRect());
      const middle = ({ top, bottom }: DOMRect) => (top + bottom) / 2;
      expect(Math.abs(middle(logo!) - middle(tabs!))).toBeLessThanOrEqual(1);
      expect(Math.abs(middle(user!) - middle(tabs!))).toBeLessThanOrEqual(1);
      expect(Math.abs((tabs!.left + tabs!.right) / 2 - width / 2)).toBeLessThanOrEqual(1);
    },
  );

  it.each([640, 1280])("puts the tabs right after the logo at %ipx", async (width) => {
    await page.viewport(width, 800);
    await loggedIn(null);
    await renderApp("/");
    const avatar = page.getByRole("img", { name: "Logged in as alice" });
    await expect.element(avatar).toBeVisible();

    const logo = page.getByRole("banner").element().firstElementChild!.getBoundingClientRect();
    const tabs = rect(page.getByRole("navigation", { name: "Main" }));
    expect(tabs.left - logo.right).toBe(24);
    expect(rect(avatar).top).toBeLessThan(tabs.bottom);
  });

  it("keeps the header on one line at 768px with every tab and Save", async () => {
    await page.viewport(768, 800);
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    await renderApp("/transactions");
    await editCounterparty("Corner Market", "Corner Shop");
    const header = page.getByRole("banner");
    await expect.element(header.getByRole("link", { name: "Documentation" })).toBeVisible();
    await expect.element(header.getByRole("button", { name: "Save" })).toBeVisible();

    const tabs = rect(page.getByRole("navigation", { name: "Main" }));
    expect(rect(header.getByRole("button", { name: "Save" })).top).toBeLessThan(tabs.bottom);
    expect(rect(page.getByRole("img", { name: "Logged in as alice" })).top).toBeLessThan(
      tabs.bottom,
    );
  });

  describe("the tabs' pill", () => {
    /** Picks Transactions, the pill having been under Overview. */
    async function pickTransactions() {
      await loggedIn(null);
      await renderApp("/");
      const nav = page.getByRole("navigation", { name: "Main" });
      await expect.element(nav).toBeVisible();
      const pill = nav.element().querySelector(":scope > [aria-hidden]")!;
      const overview = nav.getByRole("link", { name: "Overview" });
      const transactions = nav.getByRole("link", { name: "Transactions" });
      await expect.element(overview).toHaveAttribute("aria-current", "page");
      expect(pill.getBoundingClientRect().toJSON()).toEqual(rect(overview).toJSON());

      await userEvent.click(transactions);

      await expect.element(transactions).toHaveAttribute("aria-current", "page");
      return { pill, transactions };
    }

    it("goes under the tab picked", async () => {
      const { pill, transactions } = await pickTransactions();

      await expect
        .poll(() => pill.getBoundingClientRect().toJSON())
        .toEqual(rect(transactions).toJSON());
    });

    // Firefox moves it straight there, as it doesn't animate a change of anchor.
    itFailsInFirefox("slides there", async () => {
      const { pill } = await pickTransactions();

      const sliding = pill.getAnimations() as CSSTransition[];
      expect(sliding.map(({ transitionProperty }) => transitionProperty)).toContain("left");
    });
  });

  it("doesn't let the tabs' labels be selected", async () => {
    await loggedIn(null);
    await renderApp("/");
    const tabs = page.getByRole("navigation", { name: "Main" });
    await expect.element(tabs).toBeVisible();

    getSelection()!.selectAllChildren(tabs.element());

    expect(getSelection()!.toString()).toBe("");
  });

  it("shows just the logo's mark below 640px, and its name from there", async () => {
    await page.viewport(639, 800);
    await loggedIn(null);
    await renderApp("/");
    const name = page.getByRole("banner").getByText("spendy2");
    await expect.element(page.getByRole("img", { name: "Logged in as alice" })).toBeVisible();
    // Still there for screen readers.
    expect(name.element().getBoundingClientRect().width).toBeLessThanOrEqual(1);

    await page.viewport(640, 800);

    await expect.poll(() => name.element().getBoundingClientRect().width).toBeGreaterThan(50);
  });

  it("shows the user's avatar", async () => {
    await loggedIn(null);
    await renderApp("/");

    await expect.element(page.getByRole("img", { name: "Logged in as alice" })).toBeVisible();
  });

  it("opens a new database for a user who has none", async () => {
    await loggedIn(null);
    await renderApp("/transactions");

    await expect.element(page.getByText("No transactions yet.").shown()).toBeVisible();
    expect(saveButton().query()).toBeNull();
  });

  it("explains a database that can't be opened", async () => {
    await loggedIn(null);
    vi.mocked(downloadDatabase).mockResolvedValueOnce({ success: false, code: "DOWNLOAD_FAILED" });
    await renderApp("/transactions");

    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Couldn't download your database. The server may be having trouble.");
  });
});

describe("TransactionsPage", () => {
  it("lists the transactions, newest first", async () => {
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    await renderApp("/transactions");

    await expect.element(page.getByRole("grid")).toBeVisible();
    expect(columnTexts(COUNTERPARTY)).toEqual(["Corner Market", "Café Lumen"]);
  });

  it("marks an edit as unsaved and saves it", async () => {
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    await renderApp("/transactions");
    await expect.element(page.getByText("Corner Market").shown()).toBeVisible();
    expect(saveButton().query()).toBeNull();

    await editCounterparty("Corner Market", "Corner Shop");

    await expect.element(saveButton()).toHaveAccessibleName("Save");
    await expect.element(saveButton()).toBeEnabled();
    await expect.element(page.getByText("Corner Shop").shown()).toBeVisible();
    await userEvent.click(saveButton());

    await expect.element(saveButton()).not.toBeInTheDocument();
    const [, blob, precondition] = vi.mocked(uploadDatabase).mock.calls[0]!;
    expect(precondition).toEqual({ ifMatch: SHA_A });
    expect(
      await queryUploaded(blob, `SELECT counterparty FROM transactions WHERE id = '${NEWER}'`),
    ).toEqual([{ counterparty: "Corner Shop" }]);
  });

  it("shows an edited cell's new text at once, editing on into an empty cell below", async () => {
    await opened();
    // An edit before, so there's already one to undo, and unsaved changes.
    await editCounterparty("Café Lumen", "Café Lune");
    const remarks = await cellOf("Corner Market", REMARKS);
    // Empty, it's edited straight away, as Café Lumen's below it will be.
    await userEvent.click(remarks);
    await page.getByRole("textbox").fill("reimbursable");

    // What the cell shows once Enter's been handled, before the tasks it
    // queued run: what the screen could show next.
    let shown: string | null = null;
    window.addEventListener(
      "keydown",
      () => setTimeout(() => (shown = remarks.element().textContent)),
      { capture: true, once: true },
    );
    await userEvent.keyboard("{Enter}");

    await expect.poll(() => shown).toBe("reimbursable");
  });

  /** Café Lumen marked as a duplicate of Corner Market. */
  const WITH_DUPLICATE = `${TWO_TRANSACTIONS};
    UPDATE transactions SET duplicate_of = '${NEWER}' WHERE id = '${OLDER}'`;

  /** Shows the duplicates, from the table's menu. */
  async function showDuplicates() {
    await userEvent.click(page.getByRole("button", { name: "Table options" }));
    await userEvent.click(page.getByRole("checkbox", { name: "Show duplicate transactions" }));
    await userEvent.keyboard("{Escape}");
  }

  it("hides the duplicates until the table's menu shows them", async () => {
    await loggedIn(await storedDatabase(WITH_DUPLICATE));
    await renderApp("/transactions");
    await expect.element(page.getByRole("grid")).toBeVisible();
    expect(columnTexts(COUNTERPARTY)).toEqual(["Corner Market"]);

    await showDuplicates();

    await expect.poll(() => columnTexts(COUNTERPARTY)).toEqual(["Corner Market", "Café Lumen"]);
  });

  it("unmarks a duplicate from the action bar, which an undo marks again", async () => {
    await loggedIn(await storedDatabase(WITH_DUPLICATE));
    await renderApp("/transactions");
    await expect.element(page.getByRole("grid")).toBeVisible();
    await showDuplicates();
    const remarks = await cellOf("Café Lumen", REMARKS);
    await expect.element(remarks).toHaveTextContent("Duplicate of transaction 1.");
    await userEvent.click(page.getByText("Café Lumen").shown());

    await userEvent.click(page.getByRole("button", { name: "Unmark as duplicate" }));

    await expect.poll(() => remarks.element().textContent).toBe("");
    await expect.element(saveButton()).toBeInTheDocument();
    await userEvent.keyboard("{Control>}z{/Control}");
    await expect.element(remarks).toHaveTextContent("Duplicate of transaction 1.");
  });

  it("exports the database as an SQLite file, unsaved changes too, from the table's menu", async () => {
    await opened();
    await editCounterparty("Corner Market", "Corner Shop");
    const downloaded = nextDownload();

    await userEvent.click(page.getByRole("button", { name: "Table options" }));
    await userEvent.click(page.getByRole("button", { name: "Export as SQLite database" }));

    const { name, bytes } = await downloaded;
    expect(name).toBe(`spendy-${today()}.sqlite`);
    const exported = await openSqliteFile(bytes);
    expect(
      exported.selectValues(`SELECT counterparty FROM transactions ORDER BY sort_key`),
    ).toEqual(["Café Lumen", "Corner Shop"]);
    exported.close();
    // Exporting isn't saving.
    await expect.element(saveButton()).toHaveAccessibleName("Save");
  });

  it("finds a transaction from the action bar's search, to edit it there", async () => {
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    await renderApp("/transactions");
    const counterparty = await cellOf("Café Lumen", COUNTERPARTY);
    const count = page.getByRole("status");

    await userEvent.fill(page.getByRole("searchbox", { name: "Search transactions" }), "lumen");

    await expect.element(count).toHaveTextContent("1 of 1");
    expect(counterparty.element().querySelector("mark")?.textContent).toBe("Lumen");
    // It's the active cell, so pressing it edits it.
    await userEvent.click(counterparty);
    await page.getByRole("textbox").fill("Café Lune");
    await userEvent.keyboard("{Enter}");

    await expect.element(count).toHaveTextContent("No matches");
    await expect.element(await cellOf("Café Lune", COUNTERPARTY)).toHaveTextContent("Café Lune");
  });

  it("keeps the changes unsaved when saving conflicts", async () => {
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    vi.mocked(uploadDatabase).mockResolvedValue({ success: false, code: "CONFLICT" });
    await renderApp("/transactions");

    await editCounterparty("Corner Market", "Corner Shop");
    await userEvent.click(saveButton());

    await expect
      .element(page.getByText(/saved from somewhere else since you opened it/).shown())
      .toBeVisible();
    await expect.element(saveButton()).toBeEnabled();
  });

  it("keeps an edit made during a save unsaved", async () => {
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    let finishUpload!: () => void;
    vi.mocked(uploadDatabase).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishUpload = () => resolve({ success: true, sha256: SHA_B });
        }),
    );
    await renderApp("/transactions");
    await editCounterparty("Corner Market", "Corner Shop");

    await userEvent.click(saveButton());
    await expect.element(saveButton()).toHaveTextContent("Saving…");
    await editCounterparty("Café Lumen", "Café Sol");
    finishUpload();

    await expect.element(saveButton()).toHaveAccessibleName("Save");
    await expect.element(saveButton()).toBeEnabled();
  });

  it("warns before leaving with unsaved changes", async () => {
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    await renderApp("/transactions");
    await expect.element(page.getByText("Corner Market").shown()).toBeVisible();
    const leave = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(leave()).toBe(false);

    await editCounterparty("Corner Market", "Corner Shop");

    await expect.poll(leave).toBe(true);
  });

  it("lists the transactions on a phone, within the screen", async () => {
    await page.viewport(390, 800);
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    await renderApp("/transactions");

    await expect.element(list()).toMatchTextContent(/Corner Market.*Café Lumen/);
    expect(page.getByRole("grid").query()).toBeNull();
    expect(document.documentElement.scrollWidth).toBe(390);
  });

  it("shows the table from 768px wide, and the list below that", async () => {
    await page.viewport(767, 800);
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    await renderApp("/transactions");
    await expect.element(list()).toBeVisible();

    await page.viewport(768, 800);
    await expect.element(page.getByRole("grid")).toBeVisible();
    expect(list().query()).toBeNull();

    await page.viewport(767, 800);
    await expect.element(list()).toBeVisible();
    expect(page.getByRole("grid").query()).toBeNull();
  });

  it("changes the category to an existing one", async () => {
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    await renderApp("/transactions");
    const category = await cellOf("Café Lumen", CATEGORY);

    await userEvent.dblClick(category);
    await page.getByRole("combobox").fill("groc");
    await userEvent.keyboard("{Enter}");

    await expect.element(category).toHaveTextContent("Groceries");
    await expect.element(saveButton()).toBeEnabled();
  });

  it("creates a new category along with the edit, and offers it from then on", async () => {
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    await renderApp("/transactions");
    const cafe = await cellOf("Café Lumen", CATEGORY);

    await userEvent.dblClick(cafe);
    await page.getByRole("combobox").fill("Coffee");
    await userEvent.click(page.getByRole("option", { name: "Create category “Coffee”" }));

    await expect.element(cafe).toHaveTextContent("Coffee");
    await userEvent.dblClick(await cellOf("Corner Market", CATEGORY));
    await page.getByRole("combobox").fill("cof");
    await expect.element(page.getByRole("option", { name: "Coffee", exact: true })).toBeVisible();
    await userEvent.keyboard("{Escape}");

    await userEvent.click(saveButton());
    await expect.element(saveButton()).not.toBeInTheDocument();
    const [, blob] = vi.mocked(uploadDatabase).mock.calls[0]!;
    expect(
      await queryUploaded(
        blob,
        `SELECT c.name, c.parent, t.id FROM categories c
         LEFT JOIN transactions t ON t.category = c.name WHERE c.name = 'Coffee'`,
      ),
    ).toEqual([{ name: "Coffee", parent: null, id: OLDER }]);
  });

  it("stops offering a category once no transaction uses it", async () => {
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    await renderApp("/transactions");
    const market = await cellOf("Corner Market", CATEGORY);

    await userEvent.dblClick(market);
    await page.getByRole("combobox").fill("");
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => market.element().textContent).toBe("");

    await userEvent.dblClick(await cellOf("Café Lumen", CATEGORY));
    await page.getByRole("combobox").fill("Groc");
    await expect
      .element(page.getByRole("option", { name: "Create category “Groc”" }))
      .toBeVisible();
    expect(page.getByRole("option", { name: "Groceries" }).query()).toBeNull();
    await userEvent.keyboard("{Escape}");

    await userEvent.click(saveButton());
    await expect.element(saveButton()).not.toBeInTheDocument();
    const [, blob] = vi.mocked(uploadDatabase).mock.calls[0]!;
    expect(await queryUploaded(blob, "SELECT name FROM categories")).toEqual([]);
  });

  it("re-creates a category deleted while the menus were behind", async () => {
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    await renderApp("/transactions");
    const market = await cellOf("Corner Market", CATEGORY);
    const cafe = await cellOf("Café Lumen", CATEGORY);
    // The menus keep listing Groceries after it's deleted.
    const refresh = holdNextQuery((sql) => sql === LIST_CATEGORIES);
    const showError = vi.spyOn(toast, "error");

    await userEvent.dblClick(market);
    await page.getByRole("combobox").fill("");
    await userEvent.keyboard("{Enter}");
    await userEvent.dblClick(cafe);
    await userEvent.click(page.getByRole("option", { name: "Groceries" }));
    await refresh.release();

    await expect.element(cafe).toHaveTextContent("Groceries");
    await userEvent.click(saveButton());
    await expect.element(saveButton()).not.toBeInTheDocument();
    expect(showError).not.toHaveBeenCalled();
    const [, blob] = vi.mocked(uploadDatabase).mock.calls[0]!;
    expect(
      await queryUploaded(blob, "SELECT id, category FROM transactions ORDER BY sort_key DESC"),
    ).toEqual([
      { id: NEWER, category: null },
      { id: OLDER, category: "Groceries" },
    ]);
  });

  it("forgets a new category whose edit couldn't be written", async () => {
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    await renderApp("/transactions");
    vi.spyOn(Database.prototype, "batch").mockRejectedValueOnce(new Error("disk on fire"));
    const cafe = await cellOf("Café Lumen", CATEGORY);

    await userEvent.dblClick(cafe);
    await page.getByRole("combobox").fill("Coffee");
    await userEvent.keyboard("{Enter}");

    await expect
      .element(page.getByText("Couldn't change that transaction: disk on fire").shown())
      .toBeVisible();
    await expect.poll(() => cafe.element().textContent).toBe("");
    await userEvent.dblClick(cafe);
    await page.getByRole("combobox").fill("Coffee");
    await expect
      .element(page.getByRole("option", { name: "Create category “Coffee”" }))
      .toBeVisible();
  });

  it("changes the account to another existing one", async () => {
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    await renderApp("/transactions");

    await userEvent.dblClick(await cellOf("Corner Market", ACCOUNT));
    await page.getByRole("combobox").fill("sav");
    await userEvent.keyboard("{Enter}");
    await userEvent.click(saveButton());

    await expect.element(saveButton()).not.toBeInTheDocument();
    const [, blob] = vi.mocked(uploadDatabase).mock.calls[0]!;
    expect(
      await queryUploaded(blob, `SELECT account_name FROM transactions WHERE id = '${NEWER}'`),
    ).toEqual([{ account_name: "Savings" }]);
  });

  describe("sorting and filtering", () => {
    const counterparties = () => columnTexts(COUNTERPARTY);
    /** The number shown before each row's cells, top to bottom. */
    const numbers = () =>
      page
        .getByRole("row")
        .elements()
        .slice(1)
        .map((row) => row.firstElementChild!.textContent);
    const headerButton = (name: string) =>
      page.getByRole("button", { name: new RegExp(`^${name}`) });

    async function pick(header: string, role: "radio" | "checkbox", name: string) {
      await userEvent.click(headerButton(header));
      await userEvent.click(page.getByRole(role, { name }));
      await userEvent.keyboard("{Escape}");
    }

    it("sorts the table from a header's menu", async () => {
      await opened();

      await pick("Counterparty", "radio", "A to Z");

      await expect.poll(counterparties).toEqual(["Café Lumen", "Corner Market"]);
    });

    it("filters the table from a header's menu", async () => {
      await opened();

      await pick("Category", "checkbox", "Groceries");

      await expect.poll(counterparties).toEqual(["Café Lumen"]);
    });

    it("numbers the rows again as they're sorted and filtered", async () => {
      await opened();
      expect(numbers()).toEqual(["1", "2"]);

      await pick("Counterparty", "radio", "A to Z");
      await expect.poll(counterparties).toEqual(["Café Lumen", "Corner Market"]);
      expect(numbers()).toEqual(["1", "2"]);

      await pick("Category", "checkbox", "(no category)");
      await expect.poll(counterparties).toEqual(["Corner Market"]);
      expect(numbers()).toEqual(["1"]);
    });

    it("keeps the headers when every transaction is filtered out", async () => {
      await opened();

      await pick("Account", "checkbox", "All accounts");

      await expect.poll(counterparties).toEqual([]);
      await expect.element(headerButton("Account")).toBeVisible();
      await expect.element(page.getByText("No transactions yet.").shown()).not.toBeInTheDocument();
    });

    it("keeps an edited row where it is until the view changes", async () => {
      await opened();
      await pick("Counterparty", "radio", "A to Z");
      await expect.poll(counterparties).toEqual(["Café Lumen", "Corner Market"]);

      await editCounterparty("Café Lumen", "Zest Café");
      await expect.poll(counterparties).toEqual(["Zest Café", "Corner Market"]);

      await pick("Counterparty", "radio", "Z to A");
      await pick("Counterparty", "radio", "A to Z");
      await expect.poll(counterparties).toEqual(["Corner Market", "Zest Café"]);
    });

    /** Exports CSV from the table's menu, giving the file's name and text, byte order mark and all. */
    async function exportCsv() {
      const downloaded = nextDownload();
      await userEvent.click(page.getByRole("button", { name: "Table options" }));
      await userEvent.click(page.getByRole("button", { name: "Export as CSV" }));
      const { name, bytes } = await downloaded;
      return { name, text: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) };
    }

    it("exports the transactions as CSV, in the order they're shown", async () => {
      await opened();
      await pick("Counterparty", "radio", "A to Z");
      await expect.poll(counterparties).toEqual(["Café Lumen", "Corner Market"]);

      const { name, text } = await exportCsv();

      expect(name).toBe(`spendy-transactions-${today()}.csv`);
      expect(text).toBe(
        "﻿Date,Time,Account,Counterparty,Category,Currency,Amount,Remarks\r\n" +
          "2026-10-01,,Everyday Checking,Café Lumen,,USD,-5.00,\r\n" +
          "2026-10-09,,Everyday Checking,Corner Market,Groceries,USD,-46.20,\r\n",
      );
    });

    it("leaves the hidden transactions out of the CSV", async () => {
      await loggedIn(await storedDatabase(WITH_DUPLICATE));
      await renderApp("/transactions");
      await expect.element(page.getByText("Corner Market").shown()).toBeVisible();

      const { text } = await exportCsv();

      expect(text).toContain("Corner Market");
      expect(text).not.toContain("Café Lumen");
    });

    it("keeps an edited row the filters would hide until the view changes", async () => {
      await opened();
      await pick("Category", "checkbox", "(no category)");
      await expect.poll(counterparties).toEqual(["Corner Market"]);

      await userEvent.click(await cellOf("Corner Market", CATEGORY));
      await userEvent.keyboard("{Delete}");
      await expect
        .poll(async () => (await cellOf("Corner Market", CATEGORY)).element().textContent)
        .toBe("");
      expect(counterparties()).toEqual(["Corner Market"]);

      await pick("Counterparty", "radio", "A to Z");
      await expect.poll(counterparties).toEqual([]);
    });
  });

  describe("clearing a range", () => {
    const WITH_REMARKS = `${TWO_TRANSACTIONS}; UPDATE transactions SET remarks = 'Weekly'`;

    /** Selects from Corner Market's counterparty to Café Lumen's remarks. */
    async function selectRange() {
      await userEvent.click(await cellOf("Corner Market", COUNTERPARTY));
      await userEvent.keyboard("{Escape}");
      await userEvent.click(await cellOf("Café Lumen", REMARKS), { modifiers: ["Shift"] });
    }

    it("empties the cells that can be empty, in one write", async () => {
      await loggedIn(await storedDatabase(WITH_REMARKS));
      await renderApp("/transactions");
      const batch = vi.spyOn(Database.prototype, "batch");
      await selectRange();

      await userEvent.keyboard("{Delete}");
      await expect.poll(() => page.getByText("Weekly").shown().all()).toHaveLength(0);
      await userEvent.click(saveButton());

      await expect.element(saveButton()).not.toBeInTheDocument();
      expect(batch).toHaveBeenCalledTimes(1);
      const [, blob] = vi.mocked(uploadDatabase).mock.calls[0]!;
      expect(
        await queryUploaded(
          blob,
          "SELECT id, counterparty, category, amount, remarks FROM transactions ORDER BY sort_key DESC",
        ),
      ).toEqual([
        { id: NEWER, counterparty: "Corner Market", category: null, amount: 0, remarks: null },
        { id: OLDER, counterparty: "Café Lumen", category: null, amount: 0, remarks: null },
      ]);
    });

    it("puts every cell back when the write fails", async () => {
      await loggedIn(await storedDatabase(WITH_REMARKS));
      await renderApp("/transactions");
      vi.spyOn(Database.prototype, "batch").mockRejectedValueOnce(new Error("disk on fire"));
      await selectRange();

      await userEvent.keyboard("{Delete}");

      await expect
        .element(page.getByText("Couldn't change those transactions: disk on fire").shown())
        .toBeVisible();
      await expect.poll(() => page.getByText("Weekly").shown().all()).toHaveLength(2);
      await expect.element(page.getByText("Groceries").shown()).toBeVisible();
    });
  });

  it("marks an edit unsaved before it's written", async () => {
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    await renderApp("/transactions");
    const write = holdNextWorkerCall("batch");

    await editCounterparty("Corner Market", "Corner Shop");

    await expect.element(saveButton()).toBeEnabled();
    write.release();
    // Still unsaved once it's written.
    await expect.element(page.getByText("Corner Shop").shown()).toBeVisible();
    await expect.element(saveButton()).toBeEnabled();
  });

  it("puts back the stored value when an edit can't be written", async () => {
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    await renderApp("/transactions");
    const update = holdNextUpdate();

    await editCounterparty("Corner Market", "Corner Shop");
    update.fail();

    await expect
      .element(page.getByText("Couldn't change that transaction: disk on fire").shown())
      .toBeVisible();
    await expect.element(page.getByText("Corner Market").shown()).toBeVisible();
  });

  it("doesn't let a failed edit undo a later edit to the same cell", async () => {
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    await renderApp("/transactions");
    const update = holdNextUpdate();

    await editCounterparty("Corner Market", "Corner Shop");
    await editCounterparty("Corner Shop", "Corner Store");
    update.fail();

    await expect
      .element(page.getByText("Couldn't change that transaction: disk on fire").shown())
      .toBeVisible();
    await expect.element(page.getByText("Corner Store").shown()).toBeVisible();
    expect(page.getByText("Corner Market").shown().query()).toBeNull();
    await userEvent.click(saveButton());
    await expect.element(saveButton()).not.toBeInTheDocument();
    const [, blob] = vi.mocked(uploadDatabase).mock.calls[0]!;
    expect(
      await queryUploaded(blob, `SELECT counterparty FROM transactions WHERE id = '${NEWER}'`),
    ).toEqual([{ counterparty: "Corner Store" }]);
  });

  it("ignores an edit's write that fails because the database was closed", async () => {
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    const { screen } = await renderApp("/transactions");
    const update = holdNextUpdate();
    const showError = vi.spyOn(toast, "error");

    await editCounterparty("Corner Market", "Corner Shop");
    await screen.unmount();
    // Now runs against the closed database, and fails.
    await expect(update.release()).rejects.toThrow(ClosedError);
    // The failure handler runs after the rejection; give it a turn to finish.
    // (An unhandled rejection from it fails the run as a Vitest error.)
    await new Promise((resolve) => setTimeout(resolve));

    expect(showError).not.toHaveBeenCalled();
  });

  describe("amounts", () => {
    async function editAmount(from: string, to: string) {
      await userEvent.dblClick(page.getByText(from, { exact: true }).shown());
      await page.getByRole("textbox", { name: "Amount" }).fill(to);
      await userEvent.keyboard("{Enter}");
    }

    const storedAmount = async () => {
      await userEvent.click(saveButton());
      await expect.element(saveButton()).not.toBeInTheDocument();
      const [, blob] = vi.mocked(uploadDatabase).mock.calls[0]!;
      return queryUploaded(blob, `SELECT amount FROM transactions WHERE id = '${NEWER}'`);
    };

    it("stores an edited amount rounded to its currency's stored decimals", async () => {
      await opened();

      await editAmount("$46.20", "12.345");

      await expect.element(page.getByText("$12.35", { exact: true }).shown()).toBeVisible();
      expect(await storedAmount()).toEqual([{ amount: -1235 }]);
    });

    it("puts back the stored amount when an edit can't be written", async () => {
      await opened();
      const update = holdNextUpdate();

      await editAmount("$46.20", "12.5");
      update.fail();

      await expect
        .element(page.getByText("Couldn't change that transaction: disk on fire").shown())
        .toBeVisible();
      await expect.element(page.getByText("$46.20", { exact: true }).shown()).toBeVisible();
    });

    it("doesn't let a failed edit undo a later edit of the amount", async () => {
      await opened();
      const update = holdNextUpdate();

      await editAmount("$46.20", "12.5");
      await editAmount("$12.50", "7.5");
      update.fail();

      await expect
        .element(page.getByText("Couldn't change that transaction: disk on fire").shown())
        .toBeVisible();
      await expect.element(page.getByText("$7.50", { exact: true }).shown()).toBeVisible();
      expect(await storedAmount()).toEqual([{ amount: -750 }]);
    });

    it("stores a new currency, deleting the transaction's conversion to it", async () => {
      await loggedIn(await storedDatabase(WITH_CONVERSIONS));
      await renderApp("/transactions");

      await userEvent.dblClick(page.getByText("$46.20", { exact: true }).shown());
      await userEvent.keyboard("EUR{Enter}");

      await expect
        .poll(async () => (await cellOf("Corner Market", AMOUNT)).element().textContent)
        .toBe("€46.20");
      await userEvent.click(saveButton());
      await expect.element(saveButton()).not.toBeInTheDocument();
      const [, blob] = vi.mocked(uploadDatabase).mock.calls[0]!;
      expect(
        await queryUploaded(
          blob,
          `SELECT transactions.currency, transactions.amount,
            group_concat(conversions.currency) AS conversions
          FROM transactions JOIN conversions ON conversions.transaction_id = transactions.id
          WHERE id = '${NEWER}'`,
        ),
      ).toEqual([{ currency: "EUR", amount: -4620, conversions: "SGD" }]);
    });
  });
});

describe("Save on a phone", () => {
  /** Unsaved changes, made in the table, then the screen narrowed to `height` tall. */
  async function unsavedOnPhone(height = 800) {
    await opened();
    await editCounterparty("Corner Market", "Corner Shop");
    await expect.element(saveButton()).toBeVisible();
    await page.viewport(390, height);
    await expect.element(list()).toBeVisible();
  }

  it("floats at the bottom of the screen, in the middle, instead of in the header", async () => {
    await unsavedOnPhone();

    await expect.element(saveButton()).toBeVisible();
    expect(
      page
        .getByRole("banner")
        .getByRole("button", { name: /^(Save|Saving…)$/ })
        .query(),
    ).toBeNull();
    const save = rect(saveButton());
    expect(save.bottom).toBe(800 - 16);
    expect(Math.abs((save.left + save.right) / 2 - 390 / 2)).toBeLessThanOrEqual(1);
  });

  it("saves", async () => {
    await unsavedOnPhone();

    await userEvent.click(saveButton());

    await expect.element(saveButton()).not.toBeInTheDocument();
    expect(uploadDatabase).toHaveBeenCalledTimes(1);
  });

  it("doesn't cover the end of the page", async () => {
    await unsavedOnPhone(300);

    window.scrollTo(0, document.documentElement.scrollHeight);

    const last = list().getByRole("listitem").last();
    await expect.poll(() => rect(last).bottom).toBeLessThanOrEqual(rect(saveButton()).top);
  });

  it("goes back in the header from 640px, the same size", async () => {
    await unsavedOnPhone();
    await expect.element(saveButton()).toBeVisible();
    const floating = rect(saveButton());

    await page.viewport(640, 800);

    const inHeader = page.getByRole("banner").getByRole("button", { name: "Save" });
    await expect.element(inHeader).toBeVisible();
    // To a hundredth of a pixel: browsers round layout differently below that.
    expect(rect(inHeader).width).toBeCloseTo(floating.width, 2);
    expect(rect(inHeader).height).toBeCloseTo(floating.height, 2);
  });
});

describe("switching pages", () => {
  const tab = (name: string) => page.getByRole("link", { name });
  const period = (name: string) => page.getByRole("button", { name, exact: true });
  // The overview lists the same transactions, hidden or not.
  // In the cells: the header menus list some of the same names.
  const inTable = (text: string) => page.getByRole("gridcell").getByText(text);

  async function showAllTime() {
    await userEvent.click(period("All"));
    await expect.element(period("All")).toHaveAttribute("aria-pressed", "true");
  }

  /** The database queries asked for from now on, with their answers. */
  function recordQueries() {
    const original = Database.prototype.query;
    const queries: { sql: string; answer: Promise<unknown> }[] = [];
    vi.spyOn(Database.prototype, "query").mockImplementation(function (this: Database, sql, bind) {
      const answer = original.call(this, sql, bind);
      queries.push({ sql, answer });
      return answer;
    });
    return queries;
  }

  /**
   * Waits until `sql` has been asked for, and everything asked for so far is
   * answered. For a hidden page's query, once the shown page has loaded.
   */
  async function settled(queries: ReturnType<typeof recordQueries>, sql: string) {
    await expect.poll(() => queries.some((query) => query.sql === sql)).toBe(true);
    await Promise.all(queries.map(({ answer }) => answer));
  }

  it("reads the transactions while the overview shows, so they're ready to switch to", async () => {
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    const queries = recordQueries();
    await renderApp("/");
    await expect.element(page.getByRole("heading", { level: 1 })).toBeVisible();
    await settled(queries, LIST_TRANSACTIONS);
    const before = queries.length;

    await userEvent.click(tab("Transactions"));

    await expect.element(inTable("Corner Market")).toBeVisible();
    expect(queries.slice(before)).toEqual([]);
  });

  it("reads the overview while the transactions show, so it's ready to switch to", async () => {
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    const queries = recordQueries();
    await renderApp("/transactions");
    await expect.element(inTable("Corner Market")).toBeVisible();
    await settled(queries, GET_OVERVIEW_META);
    const before = queries.length;

    await userEvent.click(tab("Overview"));

    await expect.element(page.getByRole("region", { name: "Recent" })).toBeVisible();
    expect(queries.slice(before)).toEqual([]);
  });

  it("doesn't read the transactions again on coming back", async () => {
    await opened();
    await userEvent.click(tab("Overview"));
    await expect.element(page.getByRole("region", { name: "Recent" })).toBeVisible();
    const queries = recordQueries();

    await userEvent.click(tab("Transactions"));

    await expect.element(inTable("Corner Market")).toBeVisible();
    expect(queries.map(({ sql }) => sql)).not.toContain(LIST_TRANSACTIONS);
  });

  it("keeps the overview's period", async () => {
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    await renderApp("/");
    await showAllTime();

    await userEvent.click(tab("Transactions"));
    await expect.element(inTable("Corner Market")).toBeVisible();
    await userEvent.click(tab("Overview"));

    await expect.element(period("All")).toHaveAttribute("aria-pressed", "true");
  });

  it("shows an edit on the overview", async () => {
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    await renderApp("/");
    await showAllTime();
    const recent = page.getByRole("region", { name: "Recent" });
    await expect.element(recent).toMatchTextContent(/Corner Market/);

    await userEvent.click(tab("Transactions"));
    await userEvent.dblClick(inTable("Corner Market"));
    await page.getByRole("textbox").fill("Corner Shop");
    await userEvent.keyboard("{Enter}");
    await expect.element(saveButton()).toHaveAccessibleName("Save");
    await userEvent.click(tab("Overview"));

    await expect.element(recent).toMatchTextContent(/Corner Shop/);
  });

  it("finishes an edit left open by going back", async () => {
    const { router } = await opened();
    await userEvent.dblClick(inTable("Corner Market"));
    await page.getByRole("textbox").fill("Corner Shop");

    // As the browser's back button would, without leaving the cell first.
    // Hiding the page takes focus from the cell, which finishes the edit.
    await router.navigate("/");

    await expect.element(saveButton()).toHaveAccessibleName("Save");
    await router.navigate("/transactions");
    await expect.element(inTable("Corner Shop")).toBeVisible();
    expect(page.getByRole("textbox").query()).toBeNull();
  });
});

describe("a version saved elsewhere", () => {
  const SHA_C = "c".repeat(64);
  /** Corner Market renamed, as if on another device. */
  const RENAMED = `${TWO_TRANSACTIONS}; UPDATE transactions SET counterparty = 'Corner Shop' WHERE id = '${NEWER}'`;

  async function savedElsewhere(sql: string) {
    const blob = await storedDatabase(sql);
    vi.mocked(downloadDatabaseIfChanged).mockResolvedValue({ success: true, blob, sha256: SHA_C });
  }

  it("is shown in place of the open one", async () => {
    await opened();
    await savedElsewhere(RENAMED);

    checkForUpdates();

    await expect.element(page.getByText("Corner Shop").shown()).toBeVisible();
    expect(downloadDatabaseIfChanged).toHaveBeenCalledWith(TOKEN, SHA_A);
    expect(saveButton().query()).toBeNull();
  });

  it("is then the version edits are saved over", async () => {
    await opened();
    await savedElsewhere(RENAMED);
    checkForUpdates();
    await expect.element(page.getByText("Corner Shop").shown()).toBeVisible();

    await editCounterparty("Café Lumen", "Café Sol");
    await userEvent.click(saveButton());

    await expect.element(saveButton()).not.toBeInTheDocument();
    const [, blob, precondition] = vi.mocked(uploadDatabase).mock.calls[0]!;
    expect(precondition).toEqual({ ifMatch: SHA_C });
    expect(
      await queryUploaded(blob, "SELECT counterparty FROM transactions ORDER BY sort_key DESC"),
    ).toEqual([{ counterparty: "Corner Shop" }, { counterparty: "Café Sol" }]);
  });

  it("is checked for against the version just saved", async () => {
    await opened();
    await editCounterparty("Corner Market", "Corner Shop");
    await userEvent.click(saveButton());
    await expect.element(saveButton()).not.toBeInTheDocument();

    // Until the save has finished, which is a moment after Save goes (as
    // soon as nothing's unsaved): a check before then is skipped.
    await expect
      .poll(() => {
        checkForUpdates();
        return vi.mocked(downloadDatabaseIfChanged).mock.lastCall;
      })
      .toEqual([TOKEN, SHA_B]);
  });

  it("isn't checked for while there are unsaved changes", async () => {
    await opened();
    await editCounterparty("Café Lumen", "Café Sol");
    await expect.element(saveButton()).toBeVisible();
    await savedElsewhere(RENAMED);

    checkForUpdates();

    expect(downloadDatabaseIfChanged).not.toHaveBeenCalled();
    await expect.element(page.getByText("Café Sol").shown()).toBeVisible();
  });

  it("isn't checked for while a cell is being edited, but is once it isn't", async () => {
    await opened();
    await savedElsewhere(RENAMED);
    await userEvent.dblClick(page.getByText("Café Lumen").shown());
    await expect.element(page.getByRole("textbox")).toHaveFocus();

    checkForUpdates();
    expect(downloadDatabaseIfChanged).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    checkForUpdates();

    await expect.element(page.getByText("Corner Shop").shown()).toBeVisible();
  });

  it("is dropped when an edit is made while it downloads", async () => {
    await opened();
    const blob = await storedDatabase(RENAMED);
    let finishDownload!: () => void;
    vi.mocked(downloadDatabaseIfChanged).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishDownload = () => resolve({ success: true, blob, sha256: SHA_C });
        }),
    );

    checkForUpdates();
    await editCounterparty("Café Lumen", "Café Sol");
    await expect.element(saveButton()).toBeVisible();
    finishDownload();
    // Give it the chance to (wrongly) replace the data.
    await new Promise((resolve) => setTimeout(resolve, 200));

    await expect.element(page.getByText("Café Sol").shown()).toBeVisible();
    await expect.element(page.getByText("Corner Market").shown()).toBeVisible();
    await userEvent.click(saveButton());
    await expect.element(saveButton()).not.toBeInTheDocument();
    expect(vi.mocked(uploadDatabase).mock.calls[0]![2]).toEqual({ ifMatch: SHA_A });
  });

  it("is checked for again after a check fails", async () => {
    await opened();
    vi.mocked(downloadDatabaseIfChanged).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    checkForUpdates();
    await expect.poll(() => vi.mocked(downloadDatabaseIfChanged).mock.calls).toHaveLength(1);
    await savedElsewhere(RENAMED);

    checkForUpdates();

    await expect.element(page.getByText("Corner Shop").shown()).toBeVisible();
  });

  it("keeps the active cell on a row that exists when it has fewer rows", async () => {
    await opened();
    await userEvent.click(await cellOf("Café Lumen", COUNTERPARTY));
    await userEvent.keyboard("{Escape}");
    await savedElsewhere(`${TWO_TRANSACTIONS}; DELETE FROM transactions WHERE id = '${OLDER}'`);

    checkForUpdates();

    await expect.element(page.getByText("Café Lumen").shown()).not.toBeInTheDocument();
    const grid = page.getByRole("grid").element();
    const active = document.getElementById(grid.getAttribute("aria-activedescendant")!);
    expect(active?.textContent).toBe("Corner Market");
  });
});

describe("logging out", () => {
  /**
   * Opens the avatar's menu and presses Log out, once the menu's done
   * growing: the page takes no clicks while it does.
   */
  async function logOut() {
    const startViewTransition = vi.spyOn(document, "startViewTransition");
    await userEvent.click(page.getByRole("button", { name: "Logged in as alice" }));
    await startViewTransition.mock.results.at(-1)!.value.finished;
    startViewTransition.mockRestore();
    await userEvent.click(page.getByRole("button", { name: "Log out" }));
  }

  it("logs out from the avatar's menu, to the login page, and ends the session", async () => {
    const { router } = await opened();

    await logOut();

    await expect.poll(() => router.state.location.pathname).toBe("/login");
    await expect.poll(() => loadSession()).toBeNull();
    expect(logoutUser).toHaveBeenCalledExactlyOnceWith(TOKEN);
  });

  it("discards unsaved changes, without asking", async () => {
    const { router } = await opened();
    await editCounterparty("Corner Market", "Corner Shop");
    await expect.element(saveButton()).toBeVisible();
    const leave = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(leave()).toBe(true);

    await logOut();

    await expect.poll(() => router.state.location.pathname).toBe("/login");
    expect(leave()).toBe(false);
    expect(uploadDatabase).not.toHaveBeenCalled();
  });

  it("logs out though the server can't be reached", async () => {
    vi.mocked(logoutUser).mockRejectedValue(new TypeError("Failed to fetch"));
    const { router } = await opened();

    await logOut();

    await expect.poll(() => router.state.location.pathname).toBe("/login");
    await expect.poll(() => loadSession()).toBeNull();
  });

  it("stays on the documentation, which anyone can read", async () => {
    await loggedIn(null);
    const { router } = await renderApp("/docs");

    await logOut();

    await expect.element(page.getByRole("link", { name: "Log in" })).toBeVisible();
    expect(router.state.location.pathname).toBe("/docs");
  });
});

describe("a session the server no longer accepts", () => {
  it("logs out when opening the database", async () => {
    await loggedIn(null);
    vi.mocked(downloadDatabase).mockResolvedValue({ success: false, code: "UNAUTHORIZED" });

    const { router } = await renderApp("/transactions");

    await expect.poll(() => router.state.location.pathname).toBe("/login");
    await expect.poll(() => loadSession()).toBeNull();
  });

  it("logs out when checking for a version saved elsewhere", async () => {
    const { router } = await opened();
    vi.mocked(downloadDatabaseIfChanged).mockResolvedValue({
      success: false,
      code: "UNAUTHORIZED",
    });

    checkForUpdates();

    await expect.poll(() => router.state.location.pathname).toBe("/login");
    await expect.poll(() => loadSession()).toBeNull();
  });

  it("keeps an edit made while the check runs, for saving to report", async () => {
    const { router } = await opened();
    let finishCheck!: () => void;
    vi.mocked(downloadDatabaseIfChanged).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishCheck = () => resolve({ success: false, code: "UNAUTHORIZED" });
        }),
    );

    checkForUpdates();
    await editCounterparty("Café Lumen", "Café Sol");
    await expect.element(saveButton()).toBeVisible();
    finishCheck();
    // Give it the chance to (wrongly) log out.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(router.state.location.pathname).toBe("/transactions");
    await expect.element(page.getByText("Café Sol").shown()).toBeVisible();
    vi.mocked(uploadDatabase).mockResolvedValue({ success: false, code: "UNAUTHORIZED" });
    await userEvent.click(saveButton());
    await expect
      .element(page.getByText("Your session has ended. Log in again to save.").shown())
      .toBeVisible();
  });
});

/** Gives the grid focus, as the keys need, from a cell in `column` of the row showing `text`. */
async function focusGrid(text: string, column = COUNTERPARTY) {
  await userEvent.click(await cellOf(text, column));
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("grid")).toHaveFocus();
}

const button = (name: string) => page.getByRole("button", { name });
/** The cell the grid points at as active. */
const activeCell = () =>
  document.getElementById(
    page.getByRole("grid").element().getAttribute("aria-activedescendant") ?? "",
  );
/** The cell in `column` of the row `index` rows down. */
const cellAt = (index: number, column: number) =>
  page.getByRole("row").elements()[index + 1]!.querySelectorAll('[role="gridcell"]')[column];

/** Saves, and runs `sql` on the database uploaded. */
async function uploaded(sql: string) {
  await userEvent.click(saveButton());
  await expect.element(saveButton()).not.toBeInTheDocument();
  const [, blob] = vi.mocked(uploadDatabase).mock.calls.at(-1)!;
  return queryUploaded(blob, sql);
}

describe("undo and redo on the transactions page", () => {
  const undo = () => userEvent.keyboard("{Control>}z{/Control}");
  const redo = () => userEvent.keyboard("{Control>}y{/Control}");
  // In the cells: the header menus list some of the same names.
  const inTable = (text: string) => page.getByRole("gridcell").getByText(text, { exact: true });
  /** Groceries inside Food, used only by Corner Market. */
  const WITH_PARENT = `${TWO_TRANSACTIONS};
    INSERT INTO categories VALUES ('Food', NULL);
    UPDATE categories SET parent = 'Food' WHERE name = 'Groceries'`;

  async function editAmount(from: string, to: string) {
    await userEvent.dblClick(page.getByText(from, { exact: true }).shown());
    await page.getByRole("textbox", { name: "Amount" }).fill(to);
    await userEvent.keyboard("{Enter}");
  }

  it("undoes an edit and redoes it", async () => {
    await opened();
    await editCounterparty("Corner Market", "Corner Shop");

    await undo();
    await expect.element(inTable("Corner Market")).toBeVisible();
    await redo();

    await expect.element(inTable("Corner Shop")).toBeVisible();
    expect(await uploaded(`SELECT counterparty FROM transactions WHERE id = '${NEWER}'`)).toEqual([
      { counterparty: "Corner Shop" },
    ]);
  });

  it("shows an undo in the list too", async () => {
    await opened();
    await editCounterparty("Corner Market", "Corner Shop");
    await page.viewport(390, 800);
    await expect.element(list()).toMatchTextContent("Corner Shop");

    await undo();

    await expect.element(list()).toMatchTextContent("Corner Market");
  });

  it("leaves nothing to save once every edit is undone, until one is redone", async () => {
    await opened();
    await editCounterparty("Corner Market", "Corner Shop");
    await editCounterparty("Café Lumen", "Café Sol");

    await undo();
    await expect.element(saveButton()).toBeEnabled();
    await undo();
    await expect.element(inTable("Corner Market")).toBeVisible();
    await expect.element(saveButton()).not.toBeInTheDocument();
    await redo();

    await expect.element(saveButton()).toBeEnabled();
  });

  it("writes an undo to the database", async () => {
    await opened();
    await editCounterparty("Corner Market", "Corner Shop");
    await editCounterparty("Café Lumen", "Café Sol");

    await undo();

    await expect.element(inTable("Café Lumen")).toBeVisible();
    expect(await uploaded("SELECT counterparty FROM transactions ORDER BY sort_key DESC")).toEqual([
      { counterparty: "Corner Shop" },
      { counterparty: "Café Lumen" },
    ]);
  });

  it("undoes edits one at a time, latest first", async () => {
    await opened();
    await editCounterparty("Corner Market", "Corner Shop");
    await editCounterparty("Café Lumen", "Café Sol");

    await undo();

    await expect.element(inTable("Café Lumen")).toBeVisible();
    await expect.element(inTable("Corner Shop")).toBeVisible();
    await undo();
    await expect.element(inTable("Corner Market")).toBeVisible();
  });

  it("undoes an amount", async () => {
    await opened();
    await editCounterparty("Corner Market", "Corner Shop");
    await editAmount("$46.20", "12.5");

    await undo();

    await expect.element(inTable("$46.20")).toBeVisible();
    expect(
      await uploaded(`SELECT counterparty, amount FROM transactions WHERE id = '${NEWER}'`),
    ).toEqual([{ counterparty: "Corner Shop", amount: -4620 }]);
  });

  it("undoes a change of currency, with the conversion it deleted", async () => {
    await loggedIn(await storedDatabase(WITH_CONVERSIONS));
    await renderApp("/transactions");
    // Something else to save, once the change of currency is undone.
    await editCounterparty("Café Lumen", "Café Sol");
    await userEvent.dblClick(page.getByText("$46.20", { exact: true }).shown());
    await userEvent.keyboard("EUR{Enter}");
    const amount = async () => (await cellOf("Corner Market", AMOUNT)).element().textContent;
    await expect.poll(amount).toBe("€46.20");

    await undo();

    await expect.poll(amount).toBe("$46.20");
    expect(
      await uploaded(
        `SELECT transactions.currency, transactions.amount,
          group_concat(conversions.currency ORDER BY conversions.currency) AS conversions
        FROM transactions JOIN conversions ON conversions.transaction_id = transactions.id
        WHERE id = '${NEWER}'`,
      ),
    ).toEqual([{ currency: "USD", amount: -4620, conversions: "EUR,SGD" }]);
  });

  it("undoes a cleared range in one step, and selects it", async () => {
    await loggedIn(
      await storedDatabase(`${TWO_TRANSACTIONS}; UPDATE transactions SET remarks = 'Weekly'`),
    );
    await renderApp("/transactions");
    await focusGrid("Corner Market");
    await userEvent.click(await cellOf("Café Lumen", REMARKS), { modifiers: ["Shift"] });
    await userEvent.keyboard("{Delete}");
    await expect.poll(() => page.getByText("Weekly").shown().all()).toHaveLength(0);
    await focusGrid("Café Lumen", 0);

    await undo();

    await expect.poll(() => page.getByText("Weekly").shown().all()).toHaveLength(2);
    await expect.element(inTable("Groceries")).toBeVisible();
    // Groceries and both remarks changed (Café Lumen had no category to
    // clear), so the selection spans those columns of both rows.
    const selected = [...document.querySelectorAll('[role="gridcell"][aria-selected="true"]')];
    const expected = [];
    for (const row of ["Corner Market", "Café Lumen"])
      for (const column of [CATEGORY, AMOUNT, REMARKS])
        expected.push((await cellOf(row, column)).element());
    expect(selected).toEqual(expected);
    await expect.element(saveButton()).not.toBeInTheDocument();
  });

  it("puts a category deleted for being unused back inside its parent", async () => {
    await loggedIn(await storedDatabase(WITH_PARENT));
    await renderApp("/transactions");
    const market = await cellOf("Corner Market", CATEGORY);
    await userEvent.dblClick(market);
    await page.getByRole("combobox").fill("");
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => market.element().textContent).toBe("");

    await undo();

    await expect.element(market).toHaveTextContent("Groceries");
    // Exactly as saved, the category tree included.
    await expect.element(saveButton()).not.toBeInTheDocument();
    await editCounterparty("Café Lumen", "Café Sol");
    expect(await uploaded("SELECT name, parent FROM categories ORDER BY name")).toEqual([
      { name: "Food", parent: null },
      { name: "Groceries", parent: "Food" },
    ]);
  });

  it("still has something to save when a cleared category is set again by hand", async () => {
    await loggedIn(await storedDatabase(WITH_PARENT));
    await renderApp("/transactions");
    const market = await cellOf("Corner Market", CATEGORY);
    await userEvent.dblClick(market);
    await page.getByRole("combobox").fill("");
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => market.element().textContent).toBe("");

    await userEvent.dblClick(market);
    await page.getByRole("combobox").fill("Groceries");
    await userEvent.click(page.getByRole("option", { name: "Create category “Groceries”" }));
    await expect.element(market).toHaveTextContent("Groceries");

    // It's back, but no longer inside Food, which is gone.
    await expect.element(saveButton()).toBeEnabled();
    expect(await uploaded("SELECT name, parent FROM categories ORDER BY name")).toEqual([
      { name: "Groceries", parent: null },
    ]);
  });

  it("leaves nothing to save once an edit is changed back by hand", async () => {
    await opened();
    await editCounterparty("Corner Market", "Corner Shop");
    await expect.element(saveButton()).toBeEnabled();

    await editCounterparty("Corner Shop", "Corner Market");

    await expect.element(saveButton()).not.toBeInTheDocument();
  });

  it("forgets what could be redone once there's a new edit", async () => {
    await opened();
    await editCounterparty("Corner Market", "Corner Shop");
    await undo();
    await expect.element(inTable("Corner Market")).toBeVisible();

    await editCounterparty("Café Lumen", "Café Sol");
    await redo();

    await expect.element(inTable("Corner Market")).toBeVisible();
    await expect.element(inTable("Café Sol")).toBeVisible();
  });

  it("undoes past a save, leaving the undo unsaved", async () => {
    await opened();
    await editCounterparty("Corner Market", "Corner Shop");
    await userEvent.click(saveButton());
    await expect.element(saveButton()).not.toBeInTheDocument();
    // Saving took focus to the button.
    await focusGrid("Corner Shop");

    await undo();

    await expect.element(saveButton()).toBeEnabled();
    expect(await uploaded(`SELECT counterparty FROM transactions WHERE id = '${NEWER}'`)).toEqual([
      { counterparty: "Corner Market" },
    ]);
  });

  it("leaves nothing to save once undone back to what was saved", async () => {
    await opened();
    await editCounterparty("Corner Market", "Corner Shop");
    await userEvent.click(saveButton());
    await expect.element(saveButton()).not.toBeInTheDocument();
    await editCounterparty("Café Lumen", "Café Sol");
    await expect.element(saveButton()).toBeEnabled();

    await undo();

    await expect.element(inTable("Café Lumen")).toBeVisible();
    await expect.element(saveButton()).not.toBeInTheDocument();
  });

  it("forgets a new category when its edit is undone, and makes it again on redo", async () => {
    await opened();
    const cafe = await cellOf("Café Lumen", CATEGORY);
    await userEvent.dblClick(cafe);
    await page.getByRole("combobox").fill("Coffee");
    await userEvent.click(page.getByRole("option", { name: "Create category “Coffee”" }));
    await expect.element(cafe).toHaveTextContent("Coffee");

    await undo();
    await expect.poll(() => cafe.element().textContent).toBe("");
    await userEvent.dblClick(await cellOf("Corner Market", CATEGORY));
    await page.getByRole("combobox").fill("Coffee");
    await expect
      .element(page.getByRole("option", { name: "Create category “Coffee”" }))
      .toBeVisible();
    await userEvent.keyboard("{Escape}");
    await redo();

    await expect.element(cafe).toHaveTextContent("Coffee");
    expect(await uploaded("SELECT name FROM categories ORDER BY name")).toEqual([
      { name: "Coffee" },
      { name: "Groceries" },
    ]);
  });

  describe("anywhere", () => {
    const recent = () => page.getByRole("region", { name: "Recent" });

    async function showOverview() {
      await userEvent.click(page.getByRole("link", { name: "Overview" }));
      await userEvent.click(page.getByRole("button", { name: "All", exact: true }));
      await expect.element(recent()).toBeVisible();
    }

    it("undoes without the grid having focus, e.g. just after saving, and selects what changed", async () => {
      await opened();
      await editCounterparty("Corner Market", "Corner Shop");
      await userEvent.click(saveButton());
      await expect.element(saveButton()).not.toBeInTheDocument();
      expect(document.activeElement).not.toBe(page.getByRole("grid").element());

      await undo();

      await expect.element(inTable("Corner Market")).toBeVisible();
      expect(activeCell()).toBe((await cellOf("Corner Market", COUNTERPARTY)).element());
    });

    it("shows every undo made on the Overview on the transactions page", async () => {
      await opened();
      await editCounterparty("Corner Market", "Corner Shop");
      await editCounterparty("Café Lumen", "Café Sol");
      await showOverview();

      await undo();
      await undo();
      await expect.element(recent()).toMatchTextContent(/Corner Market.*Café Lumen/);
      await userEvent.click(page.getByRole("link", { name: "Transactions" }));

      await expect.element(inTable("Corner Market")).toBeVisible();
      await expect.element(inTable("Café Lumen")).toBeVisible();
    });

    it("undoes and redoes on the Overview, which shows it straight away", async () => {
      await opened();
      await editCounterparty("Corner Market", "Corner Shop");
      await showOverview();
      await expect.element(recent()).toMatchTextContent(/Corner Shop/);

      await undo();
      await expect.element(recent()).toMatchTextContent(/Corner Market/);
      await redo();

      await expect.element(recent()).toMatchTextContent(/Corner Shop/);
    });

    it("shows an undo made on the Overview on the transactions page, selected", async () => {
      await opened();
      await editCounterparty("Corner Market", "Corner Shop");
      await focusGrid("Café Lumen", REMARKS);
      await showOverview();

      await undo();
      await expect.element(recent()).toMatchTextContent(/Corner Market/);
      await userEvent.click(page.getByRole("link", { name: "Transactions" }));

      // Already shown as undone; it's selected once the page hears of the undo.
      const cell = (await cellOf("Corner Market", COUNTERPARTY)).element();
      await expect.poll(activeCell).toBe(cell);
    });

    it("says what it undid and redid where the change can't be seen, in a toast each", async () => {
      await opened();
      await editCounterparty("Corner Market", "Corner Shop");
      await showOverview();

      await undo();
      await expect
        .element(
          page
            .getByText("Undid counterparty of Corner Market: Corner Market → Corner Shop")
            .shown(),
        )
        .toBeVisible();
      await redo();

      await expect
        .element(
          page
            .getByText("Redid counterparty of Corner Market: Corner Market → Corner Shop")
            .shown(),
        )
        .toBeVisible();
      // Each gets its own toast, stacked rather than replaced.
      expect(
        page
          .getByText(/^(Undid|Redid) /)
          .shown()
          .all(),
      ).toHaveLength(2);
    });

    it("doesn't say what it undid where the change can be seen", async () => {
      await opened();
      await editCounterparty("Corner Market", "Corner Shop");

      await undo();
      await expect.element(inTable("Corner Market")).toBeVisible();
      // Give it the chance to (wrongly) say so.
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(
        page
          .getByText(/^Undid /)
          .shown()
          .query(),
      ).toBeNull();
    });

    it("leaves Ctrl+Z in a text field to the field", async () => {
      await opened();
      await editCounterparty("Corner Market", "Corner Shop");
      await showOverview();
      await userEvent.click(page.getByRole("button", { name: "Custom" }));
      await userEvent.click(page.getByLabelText("From"));

      await undo();
      // Give it the chance to (wrongly) undo.
      await new Promise((resolve) => setTimeout(resolve, 200));

      await expect.element(saveButton()).toBeEnabled();
    });
  });

  describe("in a cell being edited", () => {
    it("undoes and redoes when nothing was typed, finishing the edit", async () => {
      await opened();
      await editCounterparty("Corner Market", "Corner Shop");
      await userEvent.dblClick(inTable("Café Lumen"));
      await expect.element(page.getByRole("textbox")).toHaveFocus();

      await undo();

      await expect.element(inTable("Corner Market")).toBeVisible();
      expect(page.getByRole("textbox").query()).toBeNull();
      await userEvent.dblClick(inTable("Café Lumen"));
      await redo();
      await expect.element(inTable("Corner Shop")).toBeVisible();
    });

    it("leaves undo to the text once something was typed", async () => {
      await opened();
      await editCounterparty("Corner Market", "Corner Shop");
      await userEvent.dblClick(inTable("Café Lumen"));
      await userEvent.keyboard("{End} Sol");

      await undo();

      await expect.element(page.getByRole("textbox")).toHaveFocus();
      await userEvent.keyboard("{Escape}");
      await expect.element(inTable("Corner Shop")).toBeVisible();
    });
  });

  it("keeps the history while another page is shown", async () => {
    await opened();
    await editCounterparty("Corner Market", "Corner Shop");
    await userEvent.click(page.getByRole("link", { name: "Overview" }));
    await expect.element(page.getByRole("region", { name: "Recent" })).toBeVisible();
    await userEvent.click(page.getByRole("link", { name: "Transactions" }));
    await focusGrid("Café Lumen");

    await undo();

    await expect.element(inTable("Corner Market")).toBeVisible();
  });

  it("forgets the history when a version saved elsewhere replaces the open one", async () => {
    await opened();
    await editCounterparty("Café Lumen", "Café Sol");
    await userEvent.click(saveButton());
    await expect.element(saveButton()).not.toBeInTheDocument();
    vi.mocked(downloadDatabaseIfChanged).mockResolvedValue({
      success: true,
      blob: await storedDatabase(
        `${TWO_TRANSACTIONS}; UPDATE transactions SET counterparty = 'Corner Shop' WHERE id = '${NEWER}'`,
      ),
      sha256: "c".repeat(64),
    });
    checkForUpdates();
    await expect.element(inTable("Corner Shop")).toBeVisible();
    await focusGrid("Café Lumen");

    await undo();

    await expect.element(inTable("Café Lumen")).toBeVisible();
    expect(saveButton().query()).toBeNull();
  });

  it("can still undo earlier edits after one can't be written", async () => {
    await opened();
    await editCounterparty("Corner Market", "Corner Shop");
    vi.spyOn(Database.prototype, "batch").mockRejectedValueOnce(new Error("disk on fire"));
    await editCounterparty("Café Lumen", "Café Sol");
    await expect
      .element(page.getByText("Couldn't change that transaction: disk on fire").shown())
      .toBeVisible();
    await focusGrid("Café Lumen");

    await undo();

    await expect.element(inTable("Corner Market")).toBeVisible();
    await expect.element(saveButton()).not.toBeInTheDocument();
  });

  describe("from the action bar", () => {
    const undoButton = () => page.getByRole("button", { name: "Undo" });
    const redoButton = () => page.getByRole("button", { name: "Redo" });

    it("undoes an edit and redoes it", async () => {
      await opened();
      await editCounterparty("Corner Market", "Corner Shop");

      await userEvent.click(undoButton());
      await expect.element(inTable("Corner Market")).toBeVisible();
      await userEvent.click(redoButton());

      await expect.element(inTable("Corner Shop")).toBeVisible();
    });

    it("has nothing to undo or redo until there's an edit, and then an undo", async () => {
      await opened();
      await expect.element(undoButton()).toHaveAttribute("aria-disabled", "true");
      await expect.element(redoButton()).toHaveAttribute("aria-disabled", "true");

      await editCounterparty("Corner Market", "Corner Shop");
      await expect.element(undoButton()).not.toHaveAttribute("aria-disabled");
      await expect.element(redoButton()).toHaveAttribute("aria-disabled", "true");
      await userEvent.click(undoButton());

      await expect.element(undoButton()).toHaveAttribute("aria-disabled", "true");
      await expect.element(redoButton()).not.toHaveAttribute("aria-disabled");
    });

    it("undoes an edit in progress, leaving nothing to save, and redoes it", async () => {
      await opened();
      await userEvent.dblClick(page.getByText("Corner Market").shown());
      await page.getByRole("textbox").fill("Corner Shop");

      await userEvent.click(undoButton());

      await expect.element(page.getByRole("textbox")).not.toBeInTheDocument();
      await expect.element(inTable("Corner Market")).toBeVisible();
      await expect.element(saveButton()).not.toBeInTheDocument();
      await userEvent.click(redoButton());
      await expect.element(inTable("Corner Shop")).toBeVisible();
      await expect.element(saveButton()).toBeEnabled();
    });
  });
});

describe("adding rows on the transactions page", () => {
  const counterparties = () => columnTexts(COUNTERPARTY);

  async function sortBy(header: string, option: string) {
    await userEvent.click(page.getByRole("button", { name: new RegExp(`^${header}`) }));
    await userEvent.click(page.getByRole("radio", { name: option }));
    await userEvent.keyboard("{Escape}");
  }

  it("adds a row below the active one, on its day and in its account, selected in its column", async () => {
    await opened();
    await focusGrid("Corner Market", AMOUNT);

    await userEvent.click(button("Add row below"));

    await expect.poll(counterparties).toEqual(["Corner Market", "-", "Café Lumen"]);
    expect(columnTexts(DATE)).toEqual(["2026-10-09", "2026-10-09", "2026-10-01"]);
    expect(columnTexts(ACCOUNT)[1]).toBe("Everyday Checking");
    await expect.poll(() => activeCell() === cellAt(1, AMOUNT)).toBe(true);
    expect(
      await uploaded(
        `SELECT counterparty, amount, currency, category, remarks, sort_key FROM transactions
        WHERE naive_date = '2026-10-09' ORDER BY sort_key DESC`,
      ),
    ).toEqual([
      {
        counterparty: "Corner Market",
        amount: -4620,
        currency: "USD",
        category: "Groceries",
        remarks: null,
        sort_key: 2,
      },
      { counterparty: "-", amount: 0, currency: "USD", category: null, remarks: null, sort_key: 1 },
    ]);
  });

  it("adds a row above the active one, stored as the newer of the two", async () => {
    await opened();
    await focusGrid("Café Lumen");

    await userEvent.click(button("Add row above"));

    await expect.poll(counterparties).toEqual(["Corner Market", "-", "Café Lumen"]);
    await expect.poll(() => activeCell() === cellAt(1, COUNTERPARTY)).toBe(true);
    expect(
      await uploaded(
        `SELECT counterparty FROM transactions WHERE naive_date = '2026-10-01'
        ORDER BY sort_key DESC`,
      ),
    ).toEqual([{ counterparty: "-" }, { counterparty: "Café Lumen" }]);
  });

  it("adds a row above as the older of the two where the oldest are shown first", async () => {
    await opened();
    await sortBy("Date", "Oldest transactions first");
    await expect.poll(counterparties).toEqual(["Café Lumen", "Corner Market"]);
    await focusGrid("Café Lumen");

    await userEvent.click(button("Add row above"));

    await expect.poll(counterparties).toEqual(["-", "Café Lumen", "Corner Market"]);
    expect(
      await uploaded(
        `SELECT counterparty FROM transactions WHERE naive_date = '2026-10-01' ORDER BY sort_key`,
      ),
    ).toEqual([{ counterparty: "-" }, { counterparty: "Café Lumen" }]);
  });

  it("adds today's, in the first account, at the top, with no row active", async () => {
    await opened();

    await userEvent.click(button("Add row below"));

    await expect.poll(counterparties).toEqual(["-", "Corner Market", "Café Lumen"]);
    expect(columnTexts(DATE)[0]).toBe(today());
    expect(columnTexts(ACCOUNT)[0]).toBe("Everyday Checking");
    await expect.poll(() => activeCell() === cellAt(0, COUNTERPARTY)).toBe(true);
  });

  it("saves an edit in progress first, and adds beside the row as edited", async () => {
    await opened();
    await userEvent.dblClick(await cellOf("Café Lumen", DATE));
    await page.getByRole("textbox").fill("2026-10-05");

    await userEvent.click(button("Add row below"));

    await expect.poll(counterparties).toEqual(["Corner Market", "Café Lumen", "-"]);
    expect(columnTexts(DATE)).toEqual(["2026-10-09", "2026-10-05", "2026-10-05"]);
  });

  it("takes an added row out on undo, leaving nothing to save, and puts it back on redo, selected", async () => {
    await opened();
    await focusGrid("Corner Market", AMOUNT);
    await userEvent.click(button("Add row below"));
    await expect.poll(counterparties).toEqual(["Corner Market", "-", "Café Lumen"]);

    await userEvent.click(button("Undo"));

    await expect.poll(counterparties).toEqual(["Corner Market", "Café Lumen"]);
    await expect.element(saveButton()).not.toBeInTheDocument();
    await userEvent.click(button("Redo"));
    await expect.poll(counterparties).toEqual(["Corner Market", "-", "Café Lumen"]);
    await expect
      .poll(() => activeCell()?.closest('[role="row"]') === page.getByRole("row").elements()[2])
      .toBe(true);
  });

  it("puts an added row back where the view puts it, when redone after the view changed", async () => {
    await opened();
    await focusGrid("Corner Market");
    await userEvent.click(button("Add row below"));
    await expect.poll(counterparties).toEqual(["Corner Market", "-", "Café Lumen"]);
    await userEvent.click(button("Undo"));
    await expect.poll(counterparties).toEqual(["Corner Market", "Café Lumen"]);
    await sortBy("Counterparty", "A to Z");
    await expect.poll(counterparties).toEqual(["Café Lumen", "Corner Market"]);

    await userEvent.click(button("Redo"));

    await expect.poll(counterparties).toEqual(["-", "Café Lumen", "Corner Market"]);
  });

  it("shows the table and the bar with an account but no transactions, to add the first", async () => {
    await loggedIn(
      await storedDatabase("INSERT INTO accounts VALUES ('Savings', 'EUR', 'Bank', NULL)"),
    );
    await renderApp("/transactions");
    await expect.element(page.getByRole("grid")).toBeVisible();

    await userEvent.click(button("Add row below"));

    await expect.poll(counterparties).toEqual(["-"]);
    expect(
      await uploaded("SELECT account_name, currency, naive_date, timestamp FROM transactions"),
    ).toEqual([{ account_name: "Savings", currency: "EUR", naive_date: today(), timestamp: null }]);
  });

  it("has no table, nor a way to add a row, without an account", async () => {
    await loggedIn(null);
    await renderApp("/transactions");

    await expect.element(page.getByText("No transactions yet.").shown()).toBeVisible();
    expect(button("Add row below").query()).toBeNull();
  });
});

describe("deleting rows on the transactions page", () => {
  const counterparties = () => columnTexts(COUNTERPARTY);
  const deleteRows = () => userEvent.click(button("Delete selected rows"));

  it("deletes the active cell's row, making the next row's cell active", async () => {
    await opened();
    await focusGrid("Corner Market", AMOUNT);

    await deleteRows();

    await expect.poll(counterparties).toEqual(["Café Lumen"]);
    await expect.poll(() => activeCell() === cellAt(0, AMOUNT)).toBe(true);
    expect(await uploaded("SELECT counterparty FROM transactions")).toEqual([
      { counterparty: "Café Lumen" },
    ]);
  });

  it("deletes every row a range covers, leaving the table to add to", async () => {
    await opened();
    await focusGrid("Corner Market");
    await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");

    await deleteRows();

    await expect.poll(counterparties).toEqual([]);
    expect(activeCell()).toBeNull();
    await expect.element(button("Add row below")).toBeVisible();
    expect(await uploaded("SELECT count(*) AS count FROM transactions")).toEqual([{ count: 0 }]);
  });

  it("puts deleted rows back in place on undo, selected, leaving nothing to save, and deletes them again on redo", async () => {
    await opened();
    await focusGrid("Corner Market");
    await deleteRows();
    await expect.poll(counterparties).toEqual(["Café Lumen"]);

    await userEvent.click(button("Undo"));

    await expect.poll(counterparties).toEqual(["Corner Market", "Café Lumen"]);
    await expect.poll(() => activeCell() === cellAt(0, DATE)).toBe(true);
    await expect.element(saveButton()).not.toBeInTheDocument();
    await userEvent.click(button("Redo"));
    await expect.poll(counterparties).toEqual(["Café Lumen"]);
  });

  it("saves an edit in progress first, so an undo brings the row back as edited", async () => {
    await opened();
    await userEvent.dblClick(await cellOf("Corner Market", COUNTERPARTY));
    await page.getByRole("textbox").fill("Corner Shop");

    await deleteRows();
    await expect.poll(counterparties).toEqual(["Café Lumen"]);
    await userEvent.click(button("Undo"));

    await expect.poll(counterparties).toEqual(["Corner Shop", "Café Lumen"]);
  });

  it("says what an undo of it did where that can't be seen", async () => {
    await opened();
    await focusGrid("Corner Market");
    await deleteRows();
    await expect.poll(counterparties).toEqual(["Café Lumen"]);
    await userEvent.click(page.getByRole("link", { name: "Overview" }));
    await expect.element(page.getByText("Where it went")).toBeVisible();

    await userEvent.keyboard("{Control>}z{/Control}");

    await expect.element(page.getByText("Undid deleting Corner Market").shown()).toBeVisible();
  });
});
