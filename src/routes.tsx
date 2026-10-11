import type { RouteObject } from "react-router";
import type { IconContext } from "react-icons";
import AuthPage from "./pages/auth/AuthPage.tsx";
import AppShell from "./pages/shell/AppShell.tsx";
import TransactionsPage from "./pages/transactions/TransactionsPage.tsx";

export const routes: RouteObject[] = [
  {
    element: <AppShell />,
    children: [
      // A placeholder until the dashboard is built.
      { path: "/", element: <p className="m-auto text-ink-muted">Overview</p> },
      { path: "/transactions", element: <TransactionsPage /> },
    ],
  },
  { path: "/login", element: <AuthPage mode="login" /> },
  { path: "/register", element: <AuthPage mode="register" /> },
];

/** Sizes icons by height so non-square ones keep the same scale (see `.icon` in index.css). */
export const iconContext: IconContext = { size: "auto", className: "icon" };
