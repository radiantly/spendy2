import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import { Toaster } from "react-hot-toast";
import { IconContext } from "react-icons";
import { render } from "vitest-browser-react";
import { page, type Locator } from "vitest/browser";
import { expect } from "vitest";
import AuthProvider from "../auth/AuthProvider.tsx";
import { iconContext, routes } from "../routes.tsx";

/** Renders the app's routes at `path`, with the same providers as App. */
export async function renderApp(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const screen = await render(
    <IconContext value={iconContext}>
      <AuthProvider>
        <RouterProvider router={router} />
        <Toaster />
      </AuthProvider>
    </IconContext>,
  );
  return { router, screen };
}

/**
 * AuthPage keeps both forms in the DOM (the inactive one hidden), so most
 * queries match twice. Returns the match that is actually visible.
 */
export function visible(locator: Locator): Locator {
  const element = locator.elements().find((el) => el.checkVisibility({ visibilityProperty: true }));
  expect(element, `no visible element for ${locator.selector}`).toBeDefined();
  return page.elementLocator(element!);
}

export function rect(locator: Locator) {
  return locator.element().getBoundingClientRect();
}
