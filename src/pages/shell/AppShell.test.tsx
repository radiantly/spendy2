import { beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import toast from "react-hot-toast";
import { downloadDatabase, downloadDatabaseIfChanged, uploadDatabase } from "../../api/database.ts";
import { Database, openDatabase } from "../../db/database.ts";
import { LIST_CATEGORY_NAMES } from "../../db/queries/transactions.ts";
import { ClosedError } from "../../db/rpc.ts";
import { deriveKek } from "../../lib/kek.ts";
import { loadSession, saveSession, type Session } from "../../lib/session.ts";
import { EXPORT_KEY, TOKEN } from "../../test/fixtures.ts";
import { renderApp } from "../../test/renderAuthPage.tsx";

vi.mock("../../api/database.ts", () => ({
  downloadDatabase: vi.fn(),
  downloadDatabaseIfChanged: vi.fn(),
  uploadDatabase: vi.fn(),
}));

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

async function session(): Promise<Session> {
  return { username: "alice", token: TOKEN, kek: await deriveKek(EXPORT_KEY) };
}

/** Builds a stored database blob by running `sql` on a new database. */
async function storedDatabase(sql: string) {
  vi.mocked(downloadDatabase).mockResolvedValueOnce({ success: false, code: "NOT_FOUND" });
  vi.mocked(uploadDatabase).mockResolvedValueOnce({ success: true, sha256: SHA_A });
  const db = await openDatabase(await session());
  for (const statement of sql.split(";").filter((s) => s.trim())) await db.query(statement);
  await db.save();
  const blob = vi.mocked(uploadDatabase).mock.calls.at(-1)![1];
  db.close();
  vi.mocked(uploadDatabase).mockClear();
  return blob;
}

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

const TWO_TRANSACTIONS = `
  INSERT INTO accounts VALUES ('Everyday Checking', 'USD');
  INSERT INTO accounts VALUES ('Savings', 'USD');
  INSERT INTO sources (hash, remarks) VALUES ('h1', 'statement.csv');
  INSERT INTO categories VALUES ('Groceries', NULL);
  INSERT INTO transactions (seq, id, source, account_name, amount, currency, counterparty, category, naive_date)
    VALUES (1, 'older', 'h1', 'Everyday Checking', -50000, 'USD', 'Café Lumen', NULL, '2026-10-01');
  INSERT INTO transactions (seq, id, source, account_name, amount, currency, counterparty, category, naive_date)
    VALUES (2, 'newer', 'h1', 'Everyday Checking', -462000, 'USD', 'Corner Market', 'Groceries', '2026-10-09')
`;

beforeEach(async () => {
  vi.mocked(downloadDatabase).mockReset();
  vi.mocked(uploadDatabase).mockReset();
  vi.mocked(uploadDatabase).mockResolvedValue({ success: true, sha256: SHA_B });
  vi.mocked(downloadDatabaseIfChanged).mockReset();
  vi.mocked(downloadDatabaseIfChanged).mockResolvedValue({ success: false, code: "NOT_MODIFIED" });
  await page.viewport(1280, 800);
});

async function loggedIn(stored: Uint8Array<ArrayBuffer> | null) {
  await saveSession(await session());
  if (stored === null)
    vi.mocked(downloadDatabase).mockResolvedValue({ success: false, code: "NOT_FOUND" });
  else
    vi.mocked(downloadDatabase).mockResolvedValue({ success: true, blob: stored, sha256: SHA_A });
}

const saveButton = () => page.getByRole("button", { name: /^(Save|Saving…)$/ });

/**
 * Holds back the next call to the database's `method` whose arguments
 * match, until it's released (and then run) or failed (and never run).
 * `release` resolves once it has run.
 */
function holdNext<M extends "query" | "batch">(
  method: M,
  match: (...args: Parameters<Database[M]>) => boolean,
) {
  type Call = (this: Database, ...args: Parameters<Database[M]>) => Promise<unknown>;
  const original = Database.prototype[method] as Call;
  let settle!: (outcome: "release" | "fail") => void;
  const held = new Promise<"release" | "fail">((resolve) => (settle = resolve));
  let written: Promise<unknown> | undefined;
  const spy = vi.spyOn(Database.prototype, method as "query").mockImplementation(function (
    this: Database,
    ...args
  ) {
    const call = args as Parameters<Database[M]>;
    if (!match(...call)) return original.apply(this, call) as ReturnType<Database["query"]>;
    spy.mockRestore();
    const result = held.then((outcome) => {
      if (outcome === "fail") throw new Error("disk on fire");
      return original.apply(this, call);
    });
    written = result;
    return result as ReturnType<Database["query"]>;
  });
  return {
    release: () => {
      settle("release");
      return written;
    },
    fail: () => settle("fail"),
  };
}

const holdNextQuery = (match: (sql: string) => boolean) => holdNext("query", (sql) => match(sql));
/** Edits are written in a batch of statements. */
const holdNextUpdate = () =>
  holdNext("batch", (statements) =>
    statements.some(({ sql }) => sql.trimStart().startsWith("UPDATE")),
  );

const ACCOUNT = 1;
const COUNTERPARTY = 2;
const CATEGORY = 3;
const REMARKS = 5;

/** The cell in `column` (0-based) of the row showing `text`, once it's shown. */
async function cellOf(text: string, column: number) {
  const cell = page.getByRole("row").filter({ hasText: text }).getByRole("gridcell").nth(column);
  await expect.element(cell).toBeVisible();
  return cell;
}

async function editCounterparty(from: string, to: string) {
  await userEvent.click(page.getByText(from));
  await page.getByRole("textbox").fill(to);
  await userEvent.keyboard("{Enter}");
}

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

  it("shows the user's initial", async () => {
    await loggedIn(null);
    await renderApp("/");

    await expect.element(page.getByLabelText("Logged in as alice")).toHaveTextContent("a");
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

    await expect.element(page.getByText("2 transactions")).toBeVisible();
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
      await queryUploaded(blob, "SELECT counterparty FROM transactions WHERE id = 'newer'"),
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

  it("spans the whole page width when the table is wider than the screen", async () => {
    await page.viewport(390, 800);
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    await renderApp("/transactions");
    await expect.element(page.getByText("Corner Market")).toBeVisible();

    const pageWidth = document.documentElement.scrollWidth;
    expect(pageWidth).toBeGreaterThan(390);
    const widths = [
      page.getByRole("banner").element(),
      page.getByRole("columnheader").first().element().closest('[role="row"]')!,
      page.getByText("Corner Market").element().closest('[role="row"]')!,
    ].map((element) => element.getBoundingClientRect().width);
    expect(widths).toEqual([pageWidth, pageWidth, pageWidth]);
  });

  it("changes the category to an existing one", async () => {
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    await renderApp("/transactions");
    const category = await cellOf("Café Lumen", CATEGORY);

    await userEvent.click(category);
    await page.getByRole("combobox").fill("groc");
    await userEvent.keyboard("{Enter}");

    await expect.element(category).toHaveTextContent("Groceries");
    await expect.element(saveButton()).toBeEnabled();
  });

  it("creates a new category along with the edit, and offers it from then on", async () => {
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    await renderApp("/transactions");
    const cafe = await cellOf("Café Lumen", CATEGORY);

    await userEvent.click(cafe);
    await page.getByRole("combobox").fill("Coffee");
    await userEvent.click(page.getByRole("option", { name: "Create category “Coffee”" }));

    await expect.element(cafe).toHaveTextContent("Coffee");
    await userEvent.click(await cellOf("Corner Market", CATEGORY));
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
    ).toEqual([{ name: "Coffee", parent: null, id: "older" }]);
  });

  it("stops offering a category once no transaction uses it", async () => {
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    await renderApp("/transactions");
    const market = await cellOf("Corner Market", CATEGORY);

    await userEvent.click(market);
    await page.getByRole("combobox").fill("");
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => market.element().textContent).toBe("");

    await userEvent.click(await cellOf("Café Lumen", CATEGORY));
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

    await userEvent.click(market);
    await page.getByRole("combobox").fill("");
    await userEvent.keyboard("{Enter}");
    await userEvent.click(cafe);
    await userEvent.click(page.getByRole("option", { name: "Groceries" }));
    await refresh.release();

    await expect.element(cafe).toHaveTextContent("Groceries");
    await userEvent.click(saveButton());
    await expect.element(saveButton()).not.toBeInTheDocument();
    expect(showError).not.toHaveBeenCalled();
    const [, blob] = vi.mocked(uploadDatabase).mock.calls[0]!;
    expect(await queryUploaded(blob, "SELECT id, category FROM transactions ORDER BY id")).toEqual([
      { id: "newer", category: null },
      { id: "older", category: "Groceries" },
    ]);
  });

  it("forgets a new category whose edit couldn't be written", async () => {
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    await renderApp("/transactions");
    vi.spyOn(Database.prototype, "batch").mockRejectedValueOnce(new Error("disk on fire"));
    const cafe = await cellOf("Café Lumen", CATEGORY);

    await userEvent.click(cafe);
    await page.getByRole("combobox").fill("Coffee");
    await userEvent.keyboard("{Enter}");

    await expect
      .element(page.getByText("Couldn't change that transaction: disk on fire"))
      .toBeVisible();
    await expect.poll(() => cafe.element().textContent).toBe("");
    await userEvent.click(cafe);
    await page.getByRole("combobox").fill("Coffee");
    await expect
      .element(page.getByRole("option", { name: "Create category “Coffee”" }))
      .toBeVisible();
  });

  it("changes the account to another existing one", async () => {
    await loggedIn(await storedDatabase(TWO_TRANSACTIONS));
    await renderApp("/transactions");

    await userEvent.click(await cellOf("Corner Market", ACCOUNT));
    await page.getByRole("combobox").fill("sav");
    await userEvent.keyboard("{Enter}");
    await userEvent.click(saveButton());

    await expect.element(saveButton()).not.toBeInTheDocument();
    const [, blob] = vi.mocked(uploadDatabase).mock.calls[0]!;
    expect(
      await queryUploaded(blob, "SELECT account_name FROM transactions WHERE id = 'newer'"),
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
          "SELECT id, counterparty, category, remarks FROM transactions ORDER BY id",
        ),
      ).toEqual([
        { id: "newer", counterparty: "Corner Market", category: null, remarks: null },
        { id: "older", counterparty: "Café Lumen", category: null, remarks: null },
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
    const update = holdNextUpdate();

    await editCounterparty("Corner Market", "Corner Shop");

    await expect.element(saveButton()).toBeEnabled();
    // Let the write finish, so the database isn't closed with it still running.
    await update.release();
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
      await queryUploaded(blob, "SELECT counterparty FROM transactions WHERE id = 'newer'"),
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
});

describe("a version saved elsewhere", () => {
  const SHA_C = "c".repeat(64);
  /** Corner Market renamed, as if on another device. */
  const RENAMED = `${TWO_TRANSACTIONS}; UPDATE transactions SET counterparty = 'Corner Shop' WHERE id = 'newer'`;

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
    expect(await queryUploaded(blob, "SELECT counterparty FROM transactions ORDER BY id")).toEqual([
      { counterparty: "Corner Shop" },
      { counterparty: "Café Sol" },
    ]);
  });

  it("is checked for against the version just saved", async () => {
    await opened();
    await editCounterparty("Corner Market", "Corner Shop");
    await userEvent.click(saveButton());
    await expect.element(saveButton()).not.toBeInTheDocument();

    checkForUpdates();

    expect(downloadDatabaseIfChanged).toHaveBeenLastCalledWith(TOKEN, SHA_B);
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
    await userEvent.click(page.getByText("Café Lumen"));
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
    await savedElsewhere(`${TWO_TRANSACTIONS}; DELETE FROM transactions WHERE id = 'older'`);

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
