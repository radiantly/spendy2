import type { BindingSpec } from "@sqlite.org/sqlite-wasm";
import {
  downloadDatabase,
  downloadDatabaseIfChanged,
  uploadDatabase,
  type DownloadErrorCode,
  type UploadResult,
} from "../api/database.ts";
import type { Session } from "../lib/session.ts";
import { connect, transfer, type Connection } from "./rpc.ts";
import type { DatabaseApi, Statement } from "./worker.ts";

export class DatabaseOpenError extends Error {
  override name = "DatabaseOpenError";
  readonly code: Exclude<DownloadErrorCode, "NOT_FOUND">;

  constructor(code: DatabaseOpenError["code"]) {
    super(`Couldn't download the database: ${code}`);
    this.code = code;
  }
}

/**
 * The user's database, open in a web worker. Changes stay in memory until
 * `save()` uploads them.
 *
 * Writes go through `batch`, `undo` and `redo` (`query` is for reading), so
 * `unsaved` knows when the database differs from the version last saved.
 */
let opened = 0;

export class Database {
  /** Tells this copy apart from the others opened before it, e.g. in cache keys. */
  readonly id = ++opened;
  readonly #worker: Worker;
  readonly #connection: Connection<DatabaseApi>;
  readonly #token: string;
  #sha256: string | null;
  /** Settles when the latest save has; saves run one at a time. */
  #saving: Promise<unknown> = Promise.resolve();
  #unsaved = false;
  #version = 0;
  /** Counts writes and saves, so only the latest one's answer decides `unsaved`. */
  #changeCount = 0;
  readonly #listeners = new Set<() => void>();

  /** Use `openDatabase`. */
  constructor(
    worker: Worker,
    connection: Connection<DatabaseApi>,
    token: string,
    sha256: string | null,
  ) {
    this.#worker = worker;
    this.#connection = connection;
    this.#token = token;
    this.#sha256 = sha256;
  }

  /** The sha256 of the stored version this copy is based on; null if never saved. */
  get sha256() {
    return this.#sha256;
  }

  /**
   * Whether there are changes `save()` hasn't uploaded: the database differs
   * from the version last saved. True from the moment a write is asked for,
   * so a change is never shown without being unsaved; once the worker has
   * run it, the worker says.
   */
  get unsaved() {
    return this.#unsaved;
  }

  /**
   * Goes up each time the data changes (a write, undo or redo), for showing
   * what changed elsewhere. Not for the version saved: see `sha256`.
   */
  get version() {
    return this.#version;
  }

  /**
   * Calls `listener` when `unsaved` or `version` changes, until the returned
   * function is called. The same function every time, as
   * `useSyncExternalStore` wants.
   */
  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  #notify() {
    for (const listener of this.#listeners) listener();
  }

  #setUnsaved(unsaved: boolean) {
    if (unsaved === this.#unsaved) return;
    this.#unsaved = unsaved;
    this.#notify();
  }

  #changed() {
    this.#version++;
    this.#notify();
  }

  /**
   * Runs `change` in the worker, taking its answer about unsaved changes
   * unless a later write or save has started since: its answer will be newer.
   */
  async #change<T extends { unsaved: boolean }>(change: () => Promise<T>) {
    const count = ++this.#changeCount;
    let result: T;
    try {
      result = await change();
    } catch (error) {
      // It changed nothing, but `unsaved` may have been set for it.
      if (count === this.#changeCount) {
        const { unsaved } = await this.#connection.remote.status();
        if (count === this.#changeCount) this.#setUnsaved(unsaved);
      }
      throw error;
    }
    if (count === this.#changeCount) this.#setUnsaved(result.unsaved);
    return result;
  }

  query(sql: string, bind?: BindingSpec) {
    return this.#connection.remote.query(sql, bind);
  }

  /**
   * Runs the statements in one transaction: all of them, or none if one
   * fails. Resolves with the changes they made, for `undo` and `redo`.
   */
  async batch(statements: Statement[]) {
    this.#setUnsaved(true);
    const { changes } = await this.#change(() => this.#connection.remote.batch(statements));
    this.#changed();
    return changes;
  }

  /**
   * Undoes the changes `batch` resolved with. Rejects, changing nothing, if
   * the database no longer holds what they made.
   */
  async undo(changes: Uint8Array) {
    this.#setUnsaved(true);
    await this.#change(() => this.#connection.remote.undo(changes));
    this.#changed();
  }

  /** Makes undone changes again. Rejects, changing nothing, if they no longer fit. */
  async redo(changes: Uint8Array) {
    this.#setUnsaved(true);
    await this.#change(() => this.#connection.remote.redo(changes));
    this.#changed();
  }

  /**
   * Uploads the current state, replacing the version this copy is based on.
   * A CONFLICT is returned as is; this copy keeps its changes and its base.
   *
   * A save waits for the one before it: both would otherwise replace the
   * same version, and the second would see a conflict with itself.
   */
  save(): Promise<UploadResult> {
    const result = this.#saving.then(() => this.#upload());
    this.#saving = result.catch(() => {});
    return result;
  }

  async #upload() {
    const blob = await this.#connection.remote.export();
    let result: UploadResult;
    try {
      result = await uploadDatabase(
        this.#token,
        blob,
        this.#sha256 === null ? { ifNoneMatch: true } : { ifMatch: this.#sha256 },
      );
    } catch (error) {
      // The upload's error is what went wrong, whatever finishing says.
      await this.#change(() => this.#connection.remote.finishSave(false)).catch(() => {});
      throw error;
    }
    if (result.success) this.#sha256 = result.sha256;
    await this.#change(() => this.#connection.remote.finishSave(result.success));
    return result;
  }

  /** Stops the worker. Calls still running, and later ones, reject with a ClosedError. */
  close() {
    this.#connection.close();
    this.#worker.terminate();
  }
}

/**
 * Downloads and opens the user's database, or creates a new one if they have
 * never saved. A new database isn't uploaded until the first `save()`.
 *
 * Throws DatabaseOpenError when the download fails, and a RemoteError when the
 * blob can't be decrypted or opened (its `code` is a DatabaseBlobErrorCode
 * for blob errors). Network failures throw.
 */
export async function openDatabase(session: Session): Promise<Database> {
  // Started first, so SQLite loads while the database downloads.
  const started = startWorker();
  let download: Awaited<ReturnType<typeof downloadDatabase>>;
  try {
    download = await downloadDatabase(session.token);
    if (!download.success && download.code !== "NOT_FOUND")
      throw new DatabaseOpenError(download.code);
  } catch (error) {
    stopWorker(started);
    throw error;
  }
  return openIn(started, session, download.success ? download : null);
}

/**
 * Downloads and opens the stored database if it's newer than `current`:
 * saved since `current` was, or, if `current` was never saved, saved for
 * the first time elsewhere. Returns null otherwise, including when there's
 * no stored database. `current` stays open.
 *
 * Throws as `openDatabase` does.
 */
export async function openNewerDatabase(
  session: Session,
  current: Database,
): Promise<Database | null> {
  const download =
    current.sha256 === null
      ? await downloadDatabase(session.token)
      : await downloadDatabaseIfChanged(session.token, current.sha256);
  if (!download.success) {
    if (download.code === "NOT_FOUND" || download.code === "NOT_MODIFIED") return null;
    throw new DatabaseOpenError(download.code);
  }
  if (download.sha256 === current.sha256) return null;
  // Most checks find nothing newer, so the worker starts only once there is.
  return openIn(startWorker(), session, download);
}

type DatabaseWorker = { worker: Worker; connection: Connection<DatabaseApi> };

/** A new database worker, which starts loading SQLite straight away. */
function startWorker(): DatabaseWorker {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  return { worker, connection: connect<DatabaseApi>(worker) };
}

function stopWorker({ worker, connection }: DatabaseWorker) {
  connection.close();
  worker.terminate();
}

/**
 * Opens `stored` in `started`, or creates a new database if it's null. Stops
 * the worker if that fails.
 */
async function openIn(
  started: DatabaseWorker,
  session: Session,
  stored: { blob: Uint8Array<ArrayBuffer>; sha256: string } | null,
) {
  try {
    await started.connection.remote.open(stored && transfer(stored.blob), session.kek);
  } catch (error) {
    stopWorker(started);
    throw error;
  }
  return new Database(started.worker, started.connection, session.token, stored?.sha256 ?? null);
}
