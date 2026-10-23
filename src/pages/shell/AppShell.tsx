import { Activity, useState, type ReactNode } from "react";
import { matchPath, Navigate, useLocation } from "react-router";
import { useAuth } from "../../auth/useAuth.ts";
import DatabaseProvider from "../../db/DatabaseProvider.tsx";
import { useDatabase } from "../../db/useDatabase.ts";
import Header from "./Header.tsx";
import { useHistoryKeys } from "./historyKeys.ts";
import SaveControls from "./SaveControls.tsx";
import { describeOpenError } from "./openError.ts";

/**
 * A page in the shell, shown at `path`. A `database` page shows the user's
 * database: it's behind login, waits for the database to open, and is
 * rendered from the start so its data loads in the background. A `public`
 * page needs neither, and is rendered from its first visit.
 */
export type ShellPage = { path: string; element: ReactNode; kind: "database" | "public" };

/**
 * Layout for the app's pages: the header, and for a logged in user their
 * database, opened once for all the pages. Pages stay rendered when another
 * shows, so switching back to one finds it as it was left, and leaving the
 * database's pages doesn't lose its unsaved changes.
 */
function AppShell({ pages }: { pages: readonly ShellPage[] }) {
  const { state, endSession } = useAuth();
  const { pathname } = useLocation();
  if (state.status === "loading") return null;

  const databasePages = pages.filter(({ kind }) => kind === "database");
  const publicPages = pages.filter(({ kind }) => kind === "public");

  if (state.status === "anonymous") {
    if (!publicPages.some(({ path }) => matchPath(path, pathname)))
      return <Navigate to="/login" replace />;
    return (
      <Layout header={<Header />}>
        <PublicPages pages={publicPages} />
      </Layout>
    );
  }

  return (
    // A new session gets a fresh provider, so nothing carries over between users.
    <DatabaseProvider
      key={state.session.token}
      session={state.session}
      onSessionEnded={() => endSession(state.session)}
    >
      <Layout
        header={
          <Header username={state.session.username} actions={<SaveControls placement="header" />} />
        }
        footer={<SaveControls placement="floating" />}
      >
        <DatabasePages pages={databasePages} />
        <PublicPages pages={publicPages} />
      </Layout>
    </DatabaseProvider>
  );
}

function Layout({
  header,
  footer,
  children,
}: {
  header: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    // At least as wide as the content: a page wider than the screen scrolls
    // sideways as a whole, and everything spans that full width rather than
    // just the screen's.
    <div className="flex min-h-svh min-w-fit flex-col">
      {header}
      <main className="flex flex-1 flex-col">{children}</main>
      {footer}
    </div>
  );
}

/** The pages showing the user's database, once it's open. */
function DatabasePages({ pages }: { pages: readonly ShellPage[] }) {
  const { state } = useDatabase();
  const { pathname } = useLocation();
  useHistoryKeys(state.status === "ready" ? state.history : null);
  // Opening the database only holds up its own pages.
  const shown = pages.some(({ path }) => matchPath(path, pathname));

  if (state.status === "loading")
    return shown ? (
      <p role="status" className="m-auto text-sm text-ink-muted">
        Opening your database…
      </p>
    ) : null;

  if (state.status === "error")
    return shown ? (
      <p role="alert" className="m-auto max-w-sm text-center text-ink">
        {describeOpenError(state.error)}
      </p>
    ) : null;

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

/** The pages anyone can open: each is rendered from its first visit, then kept like the others. */
function PublicPages({ pages }: { pages: readonly ShellPage[] }) {
  const { pathname } = useLocation();
  const shown = pages.find(({ path }) => matchPath(path, pathname));
  const [visited, setVisited] = useState<readonly string[]>([]);
  if (shown && !visited.includes(shown.path)) setVisited([...visited, shown.path]);

  return pages
    .filter(({ path }) => visited.includes(path))
    .map(({ path, element }) => (
      <Activity key={path} mode={path === shown?.path ? "visible" : "hidden"}>
        {element}
      </Activity>
    ));
}

export default AppShell;
