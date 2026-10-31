import type { ReactNode } from "react";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import Header from "./Header.tsx";

function renderAt(path: string, header: ReactNode) {
  const router = createMemoryRouter([{ path, element: header }], { initialEntries: [path] });
  return render(<RouterProvider router={router} />);
}

describe("Header", () => {
  it("links to the login without a user, and has no tabs", async () => {
    await renderAt("/docs", <Header />);

    await expect
      .element(page.getByRole("link", { name: "Log in" }))
      .toHaveAttribute("href", "/login");
    expect(page.getByRole("navigation", { name: "Main" }).elements()).toHaveLength(0);
    expect(page.getByRole("img").elements()).toHaveLength(0);
  });

  it("shows the Documentation tab from 768px wide", async () => {
    await page.viewport(767, 800);
    await renderAt("/", <Header username="alice" onLogOut={() => {}} />);
    const documentation = page.getByRole("link", { name: "Documentation" });
    await expect.element(page.getByRole("link", { name: "Overview" })).toBeVisible();
    // hidden, so out of the accessibility tree
    expect(documentation.query()).toBeNull();

    await page.viewport(768, 800);

    await expect.element(documentation).toBeVisible();
    await expect.element(documentation).toHaveAttribute("href", "/docs");
  });

  it("shows a user the tabs, and their avatar after the actions", async () => {
    await renderAt(
      "/docs",
      <Header username="alice" onLogOut={() => {}} actions={<button>Save</button>} />,
    );

    await expect.element(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    const save = page.getByRole("button", { name: "Save" }).element();
    const avatar = page.getByRole("img", { name: "Logged in as alice" }).element();
    expect(save.compareDocumentPosition(avatar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(page.getByRole("link", { name: "Log in" }).elements()).toHaveLength(0);
  });
});
