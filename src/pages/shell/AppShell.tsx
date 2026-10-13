import { Activity, type ReactNode } from "react";
import { matchPath, Navigate, NavLink, useLocation } from "react-router";
import { useAuth } from "../../auth/useAuth.ts";
import DatabaseProvider from "../../db/DatabaseProvider.tsx";
import { useDatabase } from "../../db/useDatabase.ts";
import Logo from "../../components/Logo.tsx";
import SaveControls from "./SaveControls.tsx";
import { describeOpenError } from "./openError.ts";

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
      {/* At least as wide as the content: a page wider than the screen (like
          the transactions table on a phone) scrolls sideways as a whole, and
          everything spans that full width rather than just the screen's. */}
      <div className="flex min-h-svh min-w-fit flex-col">
        <Header username={state.session.username} />
        <main className="flex flex-1 flex-col">
          <DatabaseGate pages={pages} />
        </main>
      </div>
    </DatabaseProvider>
  );
}

function Header({ username }: { username: string }) {
  return (
    <header className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-4 lg:px-8">
      <Logo />
      <nav
        aria-label="Main"
        className="flex rounded-full border border-line bg-surface p-1 text-sm font-medium"
      >
        <Tab to="/">Overview</Tab>
        <Tab to="/transactions">Transactions</Tab>
      </nav>
      <div className="ml-auto flex items-center gap-4">
        <SaveControls />
        <span
          aria-label={`Logged in as ${username}`}
          className="grid size-10 place-items-center rounded-full border border-line font-display text-lg font-semibold text-ink"
        >
          {username[0]}
        </span>
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
          isActive ? "bg-ink text-canvas" : "text-ink-muted hover:text-ink"
        }`
      }
    >
      {children}
    </NavLink>
  );
}

function DatabaseGate({ pages }: { pages: readonly ShellPage[] }) {
  const { state, retry } = useDatabase();
  const { pathname } = useLocation();

  if (state.status === "loading")
    return (
      <p role="status" className="m-auto text-sm text-ink-muted">
        Opening your database…
      </p>
    );

  if (state.status === "error")
    return (
      <div className="m-auto flex max-w-sm flex-col items-center gap-4 text-center">
        <p role="alert" className="text-ink">
          {describeOpenError(state.error)}
        </p>
        <button
          type="button"
          onClick={retry}
          className="rounded-full border border-line px-4 py-2 text-sm font-medium outline-none hover:bg-field focus-visible:ring-3 focus-visible:ring-focus"
        >
          Try again
        </button>
      </div>
    );

  // Every page stays rendered, the others hidden, so switching back to one
  // finds it as it was left rather than loading again. A hidden page's
  // effects are cleaned up, and run again when it's shown.
  return pages.map(({ path, element }) => (
    <Activity key={path} mode={matchPath(path, pathname) ? "visible" : "hidden"}>
      {element}
    </Activity>
  ));
}

export default AppShell;
