/**
 * The cache of what pages read from the database, with TanStack Query.
 */
import { QueryClient } from "@tanstack/react-query";
import type { Database } from "./database.ts";

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: {
      /** Kept up to date by hand as the database changes, rather than read again. */
      updatedInPlace?: boolean;
    };
  }
}

/**
 * A cache for a session, and every version of its database opened in it.
 *
 * The data only changes through the app's own writes, which mark what's out
 * of date (see `refreshAfterWrites`), so nothing goes stale by itself. It's
 * kept while it isn't on screen: a hidden page has nothing observing its
 * data, but should find it there when it's shown again.
 */
export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // The database is local: being offline doesn't stop it, and a query
        // that failed won't succeed if it's tried again.
        networkMode: "always",
        retry: false,
        staleTime: Infinity,
        gcTime: Infinity,
      },
    },
  });
}

/** What every query key for `database`'s data starts with. */
export const databaseKey = (database: Database) => [database.id] as const;

/**
 * Marks `database`'s data out of date after each write, undo and redo, until
 * the returned function is called. What's on screen is read again straight
 * away, the rest once it's shown. Data updated in place is left alone.
 */
export function refreshAfterWrites(queryClient: QueryClient, database: Database) {
  let version = database.version;
  return database.subscribe(() => {
    if (database.version === version) return;
    version = database.version;
    void queryClient.invalidateQueries({
      queryKey: databaseKey(database),
      predicate: (query) => !query.meta?.updatedInPlace,
    });
  });
}
