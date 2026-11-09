import { beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import {
  appendDatabasePart,
  downloadDatabase,
  downloadDatabasePart,
  replaceDatabase,
} from "../../api/database.ts";
import { SOURCE_HASH_SQL, TOKEN, transactionId } from "../../test/fixtures.ts";
import { previousHashOf } from "../../test/parts.ts";
import { renderApp } from "../../test/renderAuthPage.tsx";
import { loggedIn, storedDatabase, UPLOADED } from "../../test/storedDatabase.ts";
import { DOCS_SITE } from "./docsSite.ts";

vi.mock("../../api/database.ts", () => ({
  downloadDatabase: vi.fn(),
  downloadDatabasePart: vi.fn(),
  replaceDatabase: vi.fn(),
  appendDatabasePart: vi.fn(),
}));
vi.mock("../../api/databaseUpdates.ts", () => ({ watchDatabase: vi.fn() }));

// A stand-in for the docs site, which the tests shouldn't load.
vi.mock("./docsSite.ts", () => ({ DOCS_SITE: "about:blank#docs" }));

const ONE_TRANSACTION = `
  INSERT INTO accounts VALUES ('Everyday Checking', 'USD', 'Bank', NULL);
  INSERT INTO sources (hash, remarks) VALUES (${SOURCE_HASH_SQL}, 'statement.csv');
  INSERT INTO transactions (sort_key, id, source, account_name, amount, currency, counterparty, category, naive_date)
    VALUES (1, '${transactionId(1)}', ${SOURCE_HASH_SQL}, 'Everyday Checking', -4620, 'USD', 'Corner Market', NULL, '2026-10-09')
`;

beforeEach(async () => {
  vi.mocked(downloadDatabase).mockReset();
  vi.mocked(replaceDatabase).mockReset();
  vi.mocked(replaceDatabase).mockResolvedValue(UPLOADED);
  vi.mocked(appendDatabasePart).mockReset();
  vi.mocked(appendDatabasePart).mockResolvedValue(UPLOADED);
  vi.mocked(downloadDatabasePart).mockReset();
  await page.viewport(1280, 800);
});

const reference = () => page.getByTitle("Spendy API reference");
const saveButton = () => page.getByRole("button", { name: /^(Save|Saving…)$/ });

describe("DocsPage", () => {
  it("shows logged out visitors the reference, and a link to log in", async () => {
    await renderApp("/docs");

    await expect.element(reference()).toBeVisible();
    await expect.element(page.getByRole("link", { name: "Log in" })).toBeVisible();
  });

  it("still sends logged out visitors from the database's pages to the login", async () => {
    const { router } = await renderApp("/docs");
    await expect.element(reference()).toBeVisible();

    await router.navigate("/transactions");

    await expect.poll(() => router.state.location.pathname).toBe("/login");
  });

  it("shows the docs site, sandboxed so it can't navigate the app away", async () => {
    await renderApp("/docs");
    await expect.element(reference()).toBeVisible();
    const iframe = reference().element() as HTMLIFrameElement;

    expect(iframe.getAttribute("src")).toBe(DOCS_SITE);
    expect([...iframe.sandbox].sort()).toEqual([
      "allow-downloads",
      "allow-popups",
      "allow-popups-to-escape-sandbox",
      "allow-same-origin",
      "allow-scripts",
    ]);
  });

  it("doesn't wait for the database to open", async () => {
    await loggedIn(null);
    vi.mocked(downloadDatabase).mockReturnValue(new Promise(() => {}));
    await renderApp("/docs");

    await expect.element(reference()).toBeVisible();
    expect(page.getByText("Opening your database…").query()).toBeNull();
  });

  it("isn't loaded until it's visited", async () => {
    await loggedIn(null);
    const { router } = await renderApp("/transactions");
    await expect.element(page.getByText("No transactions yet.").shown()).toBeVisible();

    expect(reference().query()).toBeNull();
    await router.navigate("/docs");
    await expect.element(reference()).toBeVisible();
  });

  it("stays loaded after it's left, so coming back doesn't load it again", async () => {
    await loggedIn(null);
    const { router } = await renderApp("/docs");
    await expect.element(reference()).toBeVisible();
    const iframe = reference().element();

    await router.navigate("/");
    await expect.element(reference()).not.toBeVisible();
    await router.navigate("/docs");

    await expect.element(reference()).toBeVisible();
    expect(reference().element()).toBe(iframe);
  });

  it("keeps unsaved changes, and saves them from here", async () => {
    const stored = await storedDatabase(ONE_TRANSACTION);
    await loggedIn(stored);
    // building the stored database downloaded it too
    vi.mocked(downloadDatabase).mockClear();
    const { router } = await renderApp("/transactions");
    await userEvent.dblClick(page.getByText("Corner Market").shown());
    await page.getByRole("textbox").fill("Corner Shop");
    await userEvent.keyboard("{Enter}");
    await expect.element(saveButton()).toHaveAccessibleName("Save");

    await router.navigate("/docs");
    await expect.element(reference()).toBeVisible();
    await router.navigate("/transactions");
    await expect.element(page.getByText("Corner Shop").shown()).toBeVisible();
    await router.navigate("/docs");
    await userEvent.click(saveButton());

    await expect.element(saveButton()).not.toBeInTheDocument();
    expect(downloadDatabase).toHaveBeenCalledOnce();
    expect(appendDatabasePart).toHaveBeenCalledWith(TOKEN, expect.any(Uint8Array));
    const [, added] = vi.mocked(appendDatabasePart).mock.lastCall!;
    expect(await previousHashOf(added)).toBe(stored.sha256);
  });
});
