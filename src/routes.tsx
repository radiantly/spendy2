import type { RouteObject } from "react-router";
import type { IconContext } from "react-icons";
import AuthPage from "./pages/auth/AuthPage.tsx";
import OverviewPage from "./pages/overview/OverviewPage.tsx";
import AppShell, { type ShellPage } from "./pages/shell/AppShell.tsx";
import TransactionsPage from "./pages/transactions/TransactionsPage.tsx";

/** The pages behind login. The shell keeps them all rendered, showing the one at the URL. */
const shellPages: ShellPage[] = [
  { path: "/", element: <OverviewPage /> },
  { path: "/transactions", element: <TransactionsPage /> },
];

export const routes: RouteObject[] = [
  {
    element: <AppShell pages={shellPages} />,
    // The shell renders the pages itself, so these routes render nothing.
    children: shellPages.map(({ path }) => ({ path, element: null })),
  },
  { path: "/login", element: <AuthPage mode="login" /> },
  { path: "/register", element: <AuthPage mode="register" /> },
];

/** Sizes icons by height so non-square ones keep the same scale (see `.icon` in index.css). */
export const iconContext: IconContext = { size: "auto", className: "icon" };
