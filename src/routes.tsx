import type { RouteObject } from "react-router";
import type { IconContext } from "react-icons";
import AuthPage from "./pages/auth/AuthPage.tsx";

// `/` is a placeholder until the dashboard is built.
export const routes: RouteObject[] = [
  { path: "/", element: <p className="p-8">Dashboard</p> },
  { path: "/login", element: <AuthPage mode="login" /> },
  { path: "/register", element: <AuthPage mode="register" /> },
];

/** Sizes icons by height so non-square ones keep the same scale (see `.icon` in index.css). */
export const iconContext: IconContext = { size: "auto", className: "icon" };
