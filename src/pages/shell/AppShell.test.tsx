import { beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { toast } from "sonner";
import { downloadDatabase, downloadDatabaseIfChanged, uploadDatabase } from "../../api/database.ts";
import { Database, openDatabase } from "../../db/database.ts";
import { LIST_CATEGORY_NAMES, LIST_TRANSACTIONS } from "../../db/queries/transactions.ts";
import { ClosedError } from "../../db/rpc.ts";
import { loadSession } from "../../lib/session.ts";
import { itFailsInFirefox } from "../../test/browsers.ts";
import { SOURCE_HASH_SQL, TOKEN, transactionId } from "../../test/fixtures.ts";
import { holdNext } from "../../test/holdNext.ts";
import { rect, renderApp } from "../../test/renderAuthPage.tsx";
import { loggedIn, SHA_A, SHA_B, session, storedDatabase } from "../../test/storedDatabase.ts";

vi.mock("../../api/database.ts", () => ({
  downloadDatabase: vi.fn(),
  downloadDatabaseIfChanged: vi.fn(),
  uploadDatabase: vi.fn(),
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
  INSERT INTO transactions (seq, id, source, account_name, amount_numerator, amount_denominator, currency, counterparty, category, naive_date)
    VALUES (1, '${OLDER}', ${SOURCE_HASH_SQL}, 'Everyday Checking', -5, 1, 'USD', 'Café Lumen', NULL, '2026-10-01');
  INSERT INTO transactions (seq, id, source, account_name, amount_numerator, amount_denominator, currency, counterparty, category, naive_date)
    VALUES (2, '${NEWER}', ${SOURCE_HASH_SQL}, 'Everyday Checking', -231, 5, 'USD', 'Corner Market', 'Groceries', '2026-10-09')
`;

beforeEach(async () => {
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

const ACCOUNT = 1;
const COUNTERPARTY = 2;
const CATEGORY = 3;
const AMOUNT = 4;
const REMARKS = 5;

/** The cell in `column` (0-based) of the row showing `text`, once it's shown. */
async function cellOf(text: string, column: number) {
  const cell = page.getByRole("row").filter({ hasText: text }).getByRole("gridcell").nth(column);
  await expect.element(cell).toBeVisible();
  return cell;
}

async function editCounterparty(from: string, to: string) {
  await userEvent.dblClick(page.getByText(from));
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
  await expect.element(page.getByText("Corner Market")).toBeVisible();
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

    await expect.element(page.getByText("No transactions yet.")).toBeVisible();
    expect(saveButton().query()).toBeNull();
  });

  it("explains a database that can't be opened and can try again", async () => {
    await loggedIn(null);
    vi.mocked(downloadDatabase).mockResolvedValueOnce({ success: false, code: "DOWNLOAD_FAILED" });
    await renderApp("/transactions");

    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Couldn't download your database. The server may be having trouble.");

    await userEvent.click(page.getByRole("button", { name: "Try again" }));

    await expect.element(page.getByText("No transactions yet.")).toBeVisible();
  });
});

describe("TransactionsPage", () => {
  it("lists the transactions, newest first", async () => {
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    await renderApp("/transactions");

    await expect.element(page.getByRole("grid")).toBeVisible();
    const counterparties = page
      .getByRole("row")
      .elements()
      .slice(1)
      .map((row) => row.children[2]!.textContent);
    expect(counterparties).toEqual(["Corner Market", "Café Lumen"]);
  });

  it("marks an edit as unsaved and saves it", async () => {
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    await renderApp("/transactions");
    await expect.element(page.getByText("Corner Market")).toBeVisible();
    expect(saveButton().query()).toBeNull();

    await editCounterparty("Corner Market", "Corner Shop");

    await expect.element(saveButton()).toHaveAccessibleName("Save");
    await expect.element(saveButton()).toBeEnabled();
    await expect.element(page.getByText("Corner Shop")).toBeVisible();
    await userEvent.click(saveButton());

    await expect.element(saveButton()).not.toBeInTheDocument();
    const [, blob, precondition] = vi.mocked(uploadDatabase).mock.calls[0]!;
    expect(precondition).toEqual({ ifMatch: SHA_A });
    expect(
      await queryUploaded(blob, `SELECT counterparty FROM transactions WHERE id = '${NEWER}'`),
    ).toEqual([{ counterparty: "Corner Shop" }]);
  });

  it("keeps the changes unsaved when saving conflicts", async () => {
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    vi.mocked(uploadDatabase).mockResolvedValue({ success: false, code: "CONFLICT" });
    await renderApp("/transactions");

    await editCounterparty("Corner Market", "Corner Shop");
    await userEvent.click(saveButton());

    await expect
      .element(page.getByText(/saved from somewhere else since you opened it/))
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
    await expect.element(page.getByText("Corner Market")).toBeVisible();
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
    const refresh = holdNextQuery((sql) => sql === LIST_CATEGORY_NAMES);
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
      await queryUploaded(blob, "SELECT id, category FROM transactions ORDER BY seq DESC"),
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
      .element(page.getByText("Couldn't change that transaction: disk on fire"))
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
      await expect.poll(() => page.getByText("Weekly").all()).toHaveLength(0);
      await userEvent.click(saveButton());

      await expect.element(saveButton()).not.toBeInTheDocument();
      expect(batch).toHaveBeenCalledTimes(1);
      const [, blob] = vi.mocked(uploadDatabase).mock.calls[0]!;
      expect(
        await queryUploaded(
          blob,
          "SELECT id, counterparty, category, remarks FROM transactions ORDER BY seq DESC",
        ),
      ).toEqual([
        { id: NEWER, counterparty: "Corner Market", category: null, remarks: null },
        { id: OLDER, counterparty: "Café Lumen", category: null, remarks: null },
      ]);
    });

    it("puts every cell back when the write fails", async () => {
      await loggedIn(await storedDatabase(WITH_REMARKS));
      await renderApp("/transactions");
      vi.spyOn(Database.prototype, "batch").mockRejectedValueOnce(new Error("disk on fire"));
      await selectRange();

      await userEvent.keyboard("{Delete}");

      await expect
        .element(page.getByText("Couldn't change those transactions: disk on fire"))
        .toBeVisible();
      await expect.poll(() => page.getByText("Weekly").all()).toHaveLength(2);
      await expect.element(page.getByText("Groceries")).toBeVisible();
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
    await expect.element(page.getByText("Corner Shop")).toBeVisible();
    await expect.element(saveButton()).toBeEnabled();
  });

  it("puts back the stored value when an edit can't be written", async () => {
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    await renderApp("/transactions");
    const update = holdNextUpdate();

    await editCounterparty("Corner Market", "Corner Shop");
    update.fail();

    await expect
      .element(page.getByText("Couldn't change that transaction: disk on fire"))
      .toBeVisible();
    await expect.element(page.getByText("Corner Market")).toBeVisible();
  });

  it("doesn't let a failed edit undo a later edit to the same cell", async () => {
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    await renderApp("/transactions");
    const update = holdNextUpdate();

    await editCounterparty("Corner Market", "Corner Shop");
    await editCounterparty("Corner Shop", "Corner Store");
    update.fail();

    await expect
      .element(page.getByText("Couldn't change that transaction: disk on fire"))
      .toBeVisible();
    await expect.element(page.getByText("Corner Store")).toBeVisible();
    expect(page.getByText("Corner Market").query()).toBeNull();
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
      await userEvent.dblClick(page.getByText(from, { exact: true }));
      await page.getByRole("textbox").fill(to);
      await userEvent.keyboard("{Enter}");
    }

    const storedAmount = async () => {
      await userEvent.click(saveButton());
      await expect.element(saveButton()).not.toBeInTheDocument();
      const [, blob] = vi.mocked(uploadDatabase).mock.calls[0]!;
      return queryUploaded(
        blob,
        `SELECT amount_numerator, amount_denominator FROM transactions WHERE id = '${NEWER}'`,
      );
    };

    it("stores an edited amount exactly, and shows it rounded", async () => {
      await opened();

      await editAmount("-46.20", "-12.345");

      await expect.element(page.getByText("-12.35", { exact: true })).toBeVisible();
      expect(await storedAmount()).toEqual([{ amount_numerator: -2469, amount_denominator: 200 }]);
    });

    it("puts back the stored amount when an edit can't be written", async () => {
      await opened();
      const update = holdNextUpdate();

      await editAmount("-46.20", "-12.5");
      update.fail();

      await expect
        .element(page.getByText("Couldn't change that transaction: disk on fire"))
        .toBeVisible();
      await expect.element(page.getByText("-46.20", { exact: true })).toBeVisible();
    });

    it("doesn't let a failed edit undo part of a later edit with the same denominator", async () => {
      await opened();
      const update = holdNextUpdate();

      await editAmount("-46.20", "-12.5");
      await editAmount("-12.50", "-7.5");
      update.fail();

      await expect
        .element(page.getByText("Couldn't change that transaction: disk on fire"))
        .toBeVisible();
      await expect.element(page.getByText("-7.50", { exact: true })).toBeVisible();
      expect(await storedAmount()).toEqual([{ amount_numerator: -15, amount_denominator: 2 }]);
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
    expect(page.getByRole("banner").getByRole("button").query()).toBeNull();
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
  const inTable = (text: string) => page.getByRole("grid").getByText(text);

  async function showAllTime() {
    await userEvent.click(period("All"));
    await expect.element(period("All")).toHaveAttribute("aria-pressed", "true");
  }

  it("shows the transactions straight away on coming back, while they're read again", async () => {
    await opened();
    await userEvent.click(tab("Overview"));
    await expect.element(page.getByRole("region", { name: "Recent" })).toBeVisible();
    const reread = holdNextQuery((sql) => sql === LIST_TRANSACTIONS);

    await userEvent.click(tab("Transactions"));

    await expect.element(inTable("Corner Market")).toBeVisible();
    expect(page.getByText("Loading transactions…").query()).toBeNull();
    await reread.release();
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

    await expect.element(page.getByText("Corner Shop")).toBeVisible();
    expect(downloadDatabaseIfChanged).toHaveBeenCalledWith(TOKEN, SHA_A);
    expect(saveButton().query()).toBeNull();
  });

  it("is then the version edits are saved over", async () => {
    await opened();
    await savedElsewhere(RENAMED);
    checkForUpdates();
    await expect.element(page.getByText("Corner Shop")).toBeVisible();

    await editCounterparty("Café Lumen", "Café Sol");
    await userEvent.click(saveButton());

    await expect.element(saveButton()).not.toBeInTheDocument();
    const [, blob, precondition] = vi.mocked(uploadDatabase).mock.calls[0]!;
    expect(precondition).toEqual({ ifMatch: SHA_C });
    expect(
      await queryUploaded(blob, "SELECT counterparty FROM transactions ORDER BY seq DESC"),
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
    await expect.element(page.getByText("Café Sol")).toBeVisible();
  });

  it("isn't checked for while a cell is being edited, but is once it isn't", async () => {
    await opened();
    await savedElsewhere(RENAMED);
    await userEvent.dblClick(page.getByText("Café Lumen"));
    await expect.element(page.getByRole("textbox")).toHaveFocus();

    checkForUpdates();
    expect(downloadDatabaseIfChanged).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    checkForUpdates();

    await expect.element(page.getByText("Corner Shop")).toBeVisible();
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

    await expect.element(page.getByText("Café Sol")).toBeVisible();
    await expect.element(page.getByText("Corner Market")).toBeVisible();
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

    await expect.element(page.getByText("Corner Shop")).toBeVisible();
  });

  it("keeps the active cell on a row that exists when it has fewer rows", async () => {
    await opened();
    await userEvent.click(await cellOf("Café Lumen", COUNTERPARTY));
    await userEvent.keyboard("{Escape}");
    await savedElsewhere(`${TWO_TRANSACTIONS}; DELETE FROM transactions WHERE id = '${OLDER}'`);

    checkForUpdates();

    await expect.element(page.getByText("Café Lumen")).not.toBeInTheDocument();
    const grid = page.getByRole("grid").element();
    const active = document.getElementById(grid.getAttribute("aria-activedescendant")!);
    expect(active?.textContent).toBe("Corner Market");
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
    await expect.element(page.getByText("Café Sol")).toBeVisible();
    vi.mocked(uploadDatabase).mockResolvedValue({ success: false, code: "UNAUTHORIZED" });
    await userEvent.click(saveButton());
    await expect
      .element(page.getByText("Your session has ended. Log in again to save."))
      .toBeVisible();
  });
});

describe("undo and redo on the transactions page", () => {
  const undo = () => userEvent.keyboard("{Control>}z{/Control}");
  const redo = () => userEvent.keyboard("{Control>}y{/Control}");
  const inTable = (text: string) => page.getByRole("grid").getByText(text, { exact: true });
  /** Groceries inside Food, used only by Corner Market. */
  const WITH_PARENT = `${TWO_TRANSACTIONS};
    INSERT INTO categories VALUES ('Food', NULL);
    UPDATE categories SET parent = 'Food' WHERE name = 'Groceries'`;

  /** Gives the grid focus, as the keys need, from a cell in `column` of the row showing `text`. */
  async function focusGrid(text: string, column = COUNTERPARTY) {
    await userEvent.click(await cellOf(text, column));
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("grid")).toHaveFocus();
  }

  async function uploaded(sql: string) {
    await userEvent.click(saveButton());
    await expect.element(saveButton()).not.toBeInTheDocument();
    const [, blob] = vi.mocked(uploadDatabase).mock.calls.at(-1)!;
    return queryUploaded(blob, sql);
  }

  async function editAmount(from: string, to: string) {
    await userEvent.dblClick(page.getByText(from, { exact: true }));
    await page.getByRole("textbox").fill(to);
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
    expect(await uploaded("SELECT counterparty FROM transactions ORDER BY seq DESC")).toEqual([
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

  it("undoes both parts of an amount", async () => {
    await opened();
    await editCounterparty("Corner Market", "Corner Shop");
    await editAmount("-46.20", "-12.5");

    await undo();

    await expect.element(inTable("-46.20")).toBeVisible();
    expect(
      await uploaded(
        `SELECT counterparty, amount_numerator, amount_denominator FROM transactions WHERE id = '${NEWER}'`,
      ),
    ).toEqual([{ counterparty: "Corner Shop", amount_numerator: -231, amount_denominator: 5 }]);
  });

  it("undoes a cleared range in one step, and selects it", async () => {
    await loggedIn(
      await storedDatabase(`${TWO_TRANSACTIONS}; UPDATE transactions SET remarks = 'Weekly'`),
    );
    await renderApp("/transactions");
    await focusGrid("Corner Market");
    await userEvent.click(await cellOf("Café Lumen", REMARKS), { modifiers: ["Shift"] });
    await userEvent.keyboard("{Delete}");
    await expect.poll(() => page.getByText("Weekly").all()).toHaveLength(0);
    await focusGrid("Café Lumen", 0);

    await undo();

    await expect.poll(() => page.getByText("Weekly").all()).toHaveLength(2);
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
    const activeCell = () =>
      document.getElementById(
        page.getByRole("grid").element().getAttribute("aria-activedescendant") ?? "",
      );
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

      await expect.element(inTable("Corner Market")).toBeVisible();
      expect(activeCell()).toBe((await cellOf("Corner Market", COUNTERPARTY)).element());
    });

    it("says what it undid and redid where the change can't be seen, in a toast each", async () => {
      await opened();
      await editCounterparty("Corner Market", "Corner Shop");
      await showOverview();

      await undo();
      await expect
        .element(page.getByText("Undid counterparty of Corner Market: Corner Market → Corner Shop"))
        .toBeVisible();
      await redo();

      await expect
        .element(page.getByText("Redid counterparty of Corner Market: Corner Market → Corner Shop"))
        .toBeVisible();
      // Each gets its own toast, stacked rather than replaced.
      expect(page.getByText(/^(Undid|Redid) /).all()).toHaveLength(2);
    });

    it("doesn't say what it undid where the change can be seen", async () => {
      await opened();
      await editCounterparty("Corner Market", "Corner Shop");

      await undo();
      await expect.element(inTable("Corner Market")).toBeVisible();
      // Give it the chance to (wrongly) say so.
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(page.getByText(/^Undid /).query()).toBeNull();
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
      .element(page.getByText("Couldn't change that transaction: disk on fire"))
      .toBeVisible();
    await focusGrid("Café Lumen");

    await undo();

    await expect.element(inTable("Corner Market")).toBeVisible();
    await expect.element(saveButton()).not.toBeInTheDocument();
  });
});
