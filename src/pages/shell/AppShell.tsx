import { Activity, type ReactNode } from "react";
import { matchPath, Navigate, NavLink, useLocation } from "react-router";
import { useAuth } from "../../auth/useAuth.ts";
import DatabaseProvider from "../../db/DatabaseProvider.tsx";
import { useDatabase } from "../../db/useDatabase.ts";
import ActivePill from "../../components/ActivePill.tsx";
import Logo from "../../components/Logo.tsx";
import UserAvatar from "../../components/UserAvatar.tsx";
import { useHistoryKeys } from "./historyKeys.ts";
import SaveControls from "./SaveControls.tsx";
import { describeOpenError } from "./openError.ts";

/** The anchor the tabs' pill is under: the active tab. */
const ACTIVE_TAB = "--active-tab";

/** A page behind login, shown at `path`. */
export type ShellPage = { path: string; element: ReactNode };

/**
 * Layout for the pages behind login: the header, and the user's database
 * opened for the pages. Pages render only once the database is ready.
 */
function AppShell({ pages }: { pages: readonly ShellPage[] }) {
  const { state, endSession } = useAuth();
  if (state.status === "loading") return null;
  if (state.status === "anonymous") return <Navigate to="/login" replace />;

  return (
    // A new session gets a fresh provider, so nothing carries over between users.
    <DatabaseProvider
      key={state.session.token}
      session={state.session}
      onSessionEnded={() => endSession(state.session)}
    >
      {/* At least as wide as the content: a page wider than the screen
          scrolls sideways as a whole, and everything spans that full width
          rather than just the screen's. */}
      <div className="flex min-h-svh min-w-fit flex-col">
        <Header username={state.session.username} />
        <main className="flex flex-1 flex-col">
          <DatabaseGate pages={pages} />
        </main>
        <SaveControls placement="floating" />
      </div>
    </DatabaseProvider>
  );
}

function Header({ username }: { username: string }) {
  return (
    // On phones, the sides share the room the tabs leave equally, so the
    // tabs sit in the middle. From 640px, they follow the logo.
    <header className="flex flex-wrap items-center gap-x-3 gap-y-3 px-4 py-4 sm:gap-x-6 lg:px-8">
      <div className="flex flex-1 sm:flex-none">
        <Logo compact />
      </div>
      <nav
        aria-label="Main"
        className="relative isolate flex rounded-full border border-line bg-surface p-1 text-sm font-medium select-none"
      >
        <Tab to="/">Overview</Tab>
        <Tab to="/transactions">Transactions</Tab>
        <ActivePill name={ACTIVE_TAB} />
      </nav>
      <div className="flex flex-1 items-center justify-end gap-4 sm:ml-auto sm:flex-none">
        <SaveControls placement="header" />
        <UserAvatar username={username} alt={`Logged in as ${username}`} />
      </div>
    </header>
  );
}

function Tab({ to, children }: { to: string; children: string }) {
  return (
    <NavLink
      to={to}
      end
      className={({ isActive }) =>
        `rounded-full px-4 py-2 outline-none focus-visible:ring-3 focus-visible:ring-focus ${
          isActive ? "text-ink" : "text-ink-muted hover:text-ink"
        }`
      }
      style={({ isActive }) => (isActive ? { anchorName: ACTIVE_TAB } : undefined)}
    >
      {children}
    </NavLink>
  );
}

function DatabaseGate({ pages }: { pages: readonly ShellPage[] }) {
  const { state } = useDatabase();
  const { pathname } = useLocation();
  useHistoryKeys(state.status === "ready" ? state.history : null);

  if (state.status === "loading")
    return (
      <p role="status" className="m-auto text-sm text-ink-muted">
        Opening your database…
      </p>
    );

  if (state.status === "error")
    return (
      <p role="alert" className="m-auto max-w-sm text-center text-ink">
        {describeOpenError(state.error)}
      </p>
    );

  // Every page stays rendered, the others hidden, so switching back to one
  // finds it as it was left. A hidden page is rendered after the shown one,
  // so its data loads in the background once the shown one's has started
  // (see the pages' usePrefetchQuery). Its effects are cleaned up, and run again when
  // it's shown.
  return pages.map(({ path, element }) => (
    <Activity key={path} mode={matchPath(path, pathname) ? "visible" : "hidden"}>
      {element}
    </Activity>
  ));
}

export default AppShell;
