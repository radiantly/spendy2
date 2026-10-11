import { beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import toast from "react-hot-toast";
import { downloadDatabase, uploadDatabase } from "../../api/database.ts";
import { Database, openDatabase } from "../../db/database.ts";
import { ClosedError } from "../../db/rpc.ts";
import { deriveKek } from "../../lib/kek.ts";
import { saveSession, type Session } from "../../lib/session.ts";
import { EXPORT_KEY, TOKEN } from "../../test/fixtures.ts";
import { renderApp } from "../../test/renderAuthPage.tsx";

vi.mock("../../api/database.ts", () => ({ downloadDatabase: vi.fn(), uploadDatabase: vi.fn() }));

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
 * Holds back the next UPDATE sent to the database until it's released (and
 * then run) or failed (and never run). `release` resolves once it has run.
 */
function holdNextUpdate() {
  const query = Database.prototype.query;
  let settle!: (outcome: "release" | "fail") => void;
  const held = new Promise<"release" | "fail">((resolve) => (settle = resolve));
  let written: Promise<unknown> | undefined;
  const spy = vi.spyOn(Database.prototype, "query").mockImplementation(function (
    this: Database,
    sql,
    bind,
  ) {
    if (!sql.trimStart().startsWith("UPDATE")) return query.call(this, sql, bind);
    spy.mockRestore();
    const result = held.then((outcome) => {
      if (outcome === "fail") throw new Error("disk on fire");
      return query.call(this, sql, bind);
    });
    written = result;
    return result;
  });
  return {
    release: () => {
      settle("release");
      return written;
    },
    fail: () => settle("fail"),
  };
}

async function editCounterparty(from: string, to: string) {
  await userEvent.click(page.getByText(from));
  await page.getByRole("textbox").fill(to);
  await userEvent.keyboard("{Enter}");
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
    await expect.element(page.getByText("Café Lumen")).toBeVisible();
    const cafeRow = page.getByText("Café Lumen").element().closest('[role="row"]')!;
    const category = cafeRow.children[3] as HTMLElement;

    await userEvent.click(page.elementLocator(category));
    await page.getByRole("textbox").fill("Groceries");
    await userEvent.keyboard("{Enter}");

    await expect.element(page.elementLocator(category)).toHaveTextContent("Groceries");
    await expect.element(saveButton()).toBeEnabled();
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
