import type { ReactNode } from "react";
import { Link, NavLink } from "react-router";
import ActivePill from "../../components/ActivePill.tsx";
import Logo from "../../components/Logo.tsx";
import UserAvatar from "../../components/UserAvatar.tsx";

/** The anchor the tabs' pill is under: the active tab. */
const ACTIVE_TAB = "--active-tab";

type HeaderProps = {
  /** The logged in user. Without one, the header links to the login instead. */
  username?: string;
  /** Shown before the user's avatar. */
  actions?: ReactNode;
};

/** The app's header: the logo, and for a logged in user the main tabs and their avatar. */
function Header({ username, actions }: HeaderProps) {
  return (
    // On phones, the sides share the room the tabs leave equally, so the
    // tabs sit in the middle. From 640px, they follow the logo.
    <header className="flex flex-wrap items-center gap-x-3 gap-y-3 px-4 py-4 sm:gap-x-6 lg:px-8">
      <div className="flex flex-1 sm:flex-none">
        <Logo compact />
      </div>
      {username !== undefined && (
        <nav
          aria-label="Main"
          className="relative isolate flex rounded-full border border-line bg-surface p-1 text-sm font-medium select-none"
        >
          <Tab to="/">Overview</Tab>
          <Tab to="/transactions">Transactions</Tab>
          {/* Narrower, the header couldn't fit it on one line alongside Save. */}
          <Tab to="/docs" className="hidden md:block">
            Documentation
          </Tab>
          <ActivePill name={ACTIVE_TAB} />
        </nav>
      )}
      <div className="flex flex-1 items-center justify-end gap-4 sm:ml-auto sm:flex-none">
        {username === undefined ? (
          <Link
            to="/login"
            className="rounded-full border border-line bg-surface px-4 py-2 text-sm font-medium text-ink outline-none hover:bg-field focus-visible:ring-3 focus-visible:ring-focus"
          >
            Log in
          </Link>
        ) : (
          <>
            {actions}
            <UserAvatar username={username} alt={`Logged in as ${username}`} />
          </>
        )}
      </div>
    </header>
  );
}

function Tab({
  to,
  className = "",
  children,
}: {
  to: string;
  className?: string;
  children: string;
}) {
  return (
    <NavLink
      to={to}
      end
      className={({ isActive }) =>
        `rounded-full px-4 py-2 outline-none focus-visible:ring-3 focus-visible:ring-focus ${
          isActive ? "text-ink" : "text-ink-muted hover:text-ink"
        } ${className}`
      }
      style={({ isActive }) => (isActive ? { anchorName: ACTIVE_TAB } : undefined)}
    >
      {children}
    </NavLink>
  );
}

export default Header;
