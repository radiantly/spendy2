/**
 * Watching the user's database for changes saved elsewhere, over the
 * server's WebSocket (see worker/routes/users/updates.ts), which tells the
 * socket the database's last part each time it changes.
 */
import { DATABASE_UPDATES_CLOSE, databaseUpdateSchema } from "../../worker/schemas.ts";

/** How often a keepalive is sent (ms), so nothing in between closes an idle socket. */
export const PING_INTERVAL = 30_000;
/** How long to wait before connecting again (ms), after each try in a row; then the last. */
export const RETRY_DELAYS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

export type DatabaseWatcher = {
  /**
   * The sha256 of the stored database's last part, null without a database:
   * on each connection, and after each change.
   */
  onHead: (sha256: string | null) => void;
  /** The server no longer accepts the session; nothing more is heard. */
  onSessionEnded: () => void;
};

/** What a message from the server says, if it's an update. */
function updateIn(data: unknown) {
  if (typeof data !== "string") return null;
  try {
    const update = databaseUpdateSchema.safeParse(JSON.parse(data));
    return update.success ? update.data : null;
  } catch {
    return null;
  }
}

/**
 * Watches `username`'s database with the session `token`, until the
 * returned function is called. The socket connects again whenever it
 * closes, sooner the first few times: each connection is told the last part
 * straight away, so nothing saved meanwhile is missed.
 */
export function watchDatabase(username: string, token: string, watcher: DatabaseWatcher) {
  let socket: WebSocket | undefined;
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  function connect() {
    // Relative, as the browser takes it: ws: or wss:, as the page is served.
    const ws = new WebSocket(`/api/users/${username}/database/updates`);
    socket = ws;
    ws.addEventListener("open", () => {
      // A browser's socket can't send an Authorization header.
      ws.send(JSON.stringify({ token }));
      pingTimer = setInterval(() => ws.send("ping"), PING_INTERVAL);
    });
    ws.addEventListener("message", ({ data }) => {
      const update = updateIn(data);
      // Pongs, and anything else, are only to keep it open.
      if (update === null) return;
      retries = 0;
      watcher.onHead(update.sha256);
    });
    ws.addEventListener("close", ({ code }) => {
      if (pingTimer !== undefined) clearInterval(pingTimer);
      if (stopped) return;
      if (code === DATABASE_UPDATES_CLOSE.UNAUTHORIZED) {
        stopped = true;
        watcher.onSessionEnded();
        return;
      }
      retryTimer = setTimeout(connect, RETRY_DELAYS[Math.min(retries++, RETRY_DELAYS.length - 1)]);
    });
  }

  connect();
  return () => {
    stopped = true;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    if (pingTimer !== undefined) clearInterval(pingTimer);
    socket?.close();
  };
}
