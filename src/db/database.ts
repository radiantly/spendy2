import type { BindingSpec } from "@sqlite.org/sqlite-wasm";
import {
  appendDatabasePart,
  downloadDatabase,
  downloadDatabasePart,
  replaceDatabase,
  type DownloadErrorCode,
  type UploadErrorCode,
  type UploadResult,
} from "../api/database.ts";
import type { LatestPart } from "../api/databaseUpdates.ts";
import type { Session } from "../lib/session.ts";
import { connect, RemoteError, transfer, type Connection } from "./rpc.ts";
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
 * How a save went. NEWER_VERSION means it was saved elsewhere by a newer
 * version of the app, so this one can't move its changes onto it.
 */
export type SaveResult =
  | { success: true; sha256: string }
  | { success: false; code: SaveErrorCode };

export type SaveErrorCode = UploadErrorCode | "NEWER_VERSION";

/**
 * How bringing in what was saved elsewhere went (see `catchUp`): `updated`
 * if anything was. CONFLICT and NEWER_VERSION are as for a save; this copy
 * then keeps its changes and its base.
 */
export type CatchUpResult =
  | { success: true; updated: boolean }
  | {
      success: false;
      code: "CONFLICT" | "NEWER_VERSION" | Exclude<DownloadErrorCode, "NOT_FOUND">;
    };

/** `parts`, one after the other, as they're downloaded. */
function concat(parts: readonly Uint8Array<ArrayBuffer>[]) {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

/** How many times a save moves its changes onto a version saved elsewhere before giving up. */
const MAX_REBASES = 3;

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
  /**
   * The sha256 of each stored part this copy is based on, in order: the
   * next save follows the last, and goes at their count.
   */
  #hashes: string[];
  /** Settles when the latest save or catch-up has; they run one at a time. */
  #saving: Promise<unknown> = Promise.resolve();
  #unsaved = false;
  #version = 0;
  #rebases = 0;
  /** Counts writes and saves, so only the latest one's answer decides `unsaved`. */
  #changeCount = 0;
  readonly #listeners = new Set<() => void>();

  /** Use `openDatabase`. */
  constructor(
    worker: Worker,
    connection: Connection<DatabaseApi>,
    token: string,
    { hashes }: { hashes: string[] },
  ) {
    this.#worker = worker;
    this.#connection = connection;
    this.#token = token;
    this.#hashes = hashes;
  }

  /**
   * The sha256 of the last stored part this copy is based on, which the
   * next save follows; null if never saved.
   */
  get sha256() {
    return this.#hashes.at(-1) ?? null;
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
   * Goes up each time the data changes (a write, undo, redo or rebase), for
   * showing what changed elsewhere. Not for the version saved: see `sha256`.
   */
  get version() {
    return this.#version;
  }

  /**
   * Goes up each time this copy's changes are moved onto a version saved
   * elsewhere, bringing in what changed there (see `catchUp` and `save`):
   * anything read from it is out of date, also what's otherwise kept up to
   * date edit by edit (see `keepTransactionsInSync`).
   */
  get rebases() {
    return this.#rebases;
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
   * Uploads the changes since the version this copy is based on, or the
   * whole database if it was never saved.
   *
   * If another version was saved since (elsewhere), the changes are moved
   * onto it, bringing in what changed there, and uploaded again. If they
   * change what was changed there too, a CONFLICT is returned, and this copy
   * keeps its changes and its base.
   *
   * A save waits for the one before it: both would otherwise follow the
   * same version, and the second would see a conflict with itself.
   */
  save(): Promise<SaveResult> {
    const result = this.#saving.then(() => this.#save());
    this.#saving = result.catch(() => {});
    return result;
  }

  async #save(): Promise<SaveResult> {
    for (let rebases = 0; ; rebases++) {
      const result = await this.#upload();
      if (result.success || result.code !== "CONFLICT" || rebases === MAX_REBASES) return result;
      const caught = await this.#catchUp();
      if (!caught.success)
        return {
          success: false,
          code: caught.code === "DOWNLOAD_FAILED" ? "UPLOAD_FAILED" : caught.code,
        };
    }
  }

  /**
   * Brings in what was saved elsewhere, the server saying the stored
   * database's last part is `latestPart` (null without one): the unsaved
   * changes are moved onto it, as a save does when it finds another version
   * saved since (see `save`). Nothing's done if this copy is based on that
   * part, its last or one before: it's up to date already. Only the parts
   * after this copy's are downloaded, unless the stored chain was replaced.
   *
   * It waits for any save, and saves wait for it: both move this copy's base.
   */
  catchUp(latestPart: LatestPart | null): Promise<CatchUpResult> {
    const result = this.#saving.then(() => this.#catchUpTo(latestPart));
    this.#saving = result.catch(() => {});
    return result;
  }

  async #catchUpTo(latestPart: LatestPart | null): Promise<CatchUpResult> {
    if (latestPart === null || this.#hashes[latestPart.index] === latestPart.hash)
      return { success: true, updated: false };
    // Parts after this copy's are downloaded on their own, unless they don't
    // follow it. Without parts of its own, or with a different part where it
    // has one (the stored chain was replaced), the whole chain is needed.
    if (this.#hashes.length > 0 && latestPart.index >= this.#hashes.length) {
      const added = await this.#downloadPartsThrough(latestPart.index);
      if (!added.success) return added;
      if (added.parts !== null) {
        const moved = await this.#moveOnto(added.parts);
        if (moved !== null) return moved;
      }
    }
    return this.#rebase();
  }

  /** Brings in whatever was saved since this copy's version (see `save`). */
  async #catchUp(): Promise<CatchUpResult> {
    if (this.#hashes.length > 0) {
      const added = await this.#downloadPartsAdded();
      if (!added.success) return added;
      if (added.parts.length > 0) {
        const moved = await this.#moveOnto(added.parts);
        if (moved !== null) return moved;
      }
    }
    return this.#rebase();
  }

  /**
   * Moves the unsaved changes onto `parts`, those stored after this copy's.
   * Null if they don't follow its: the whole chain is needed.
   */
  #moveOnto(parts: readonly Uint8Array<ArrayBuffer>[]) {
    return this.#move(() => this.#connection.remote.catchUp(transfer(concat(parts))), this.#hashes);
  }

  /** Moves the unsaved changes onto the whole stored database, unless it's this copy's version. */
  async #rebase(): Promise<CatchUpResult> {
    const download = await downloadDatabase(this.#token);
    if (!download.success)
      return download.code === "NOT_FOUND"
        ? { success: true, updated: false }
        : { success: false, code: download.code };
    if (download.sha256 === this.sha256) return { success: true, updated: false };
    return (await this.#move(() => this.#connection.remote.rebase(transfer(download.parts)), []))!;
  }

  /**
   * The parts stored after the ones this copy is based on, up to the one at
   * index `last`, by downloading each in turn. Null if one isn't there: the
   * stored chain was replaced since.
   */
  async #downloadPartsThrough(last: number) {
    const parts: Uint8Array<ArrayBuffer>[] = [];
    for (let index = this.#hashes.length; index <= last; index++) {
      const download = await downloadDatabasePart(this.#token, index);
      if (download.success) parts.push(download.parts);
      else if (download.code === "NOT_FOUND") return { success: true as const, parts: null };
      else return { success: false as const, code: download.code };
    }
    return { success: true as const, parts };
  }

  /** The parts stored after the ones this copy is based on, by downloading each in turn. */
  async #downloadPartsAdded() {
    const parts: Uint8Array<ArrayBuffer>[] = [];
    for (let index = this.#hashes.length; ; index++) {
      const download = await downloadDatabasePart(this.#token, index);
      if (download.success) parts.push(download.parts);
      else if (download.code === "NOT_FOUND") return { success: true as const, parts };
      else return { success: false as const, code: download.code };
    }
  }

  /**
   * Moves the unsaved changes onto a newer version, as `move` does in the
   * worker, taking what it says: the parts it reads follow `base`, the
   * hashes of the parts before them. Null if they don't follow this copy's.
   */
  async #move(
    move: () => ReturnType<DatabaseApi["rebase"]>,
    base: readonly string[],
  ): Promise<CatchUpResult | null> {
    let moved;
    try {
      moved = await this.#change(move);
    } catch (error) {
      if (error instanceof RemoteError && error.name === "DatabaseTooNewError")
        return { success: false, code: "NEWER_VERSION" };
      throw error;
    }
    if (moved.outcome === "unchained") return null;
    if (moved.outcome === "conflict") return { success: false, code: "CONFLICT" };

    this.#hashes = [...base, ...moved.hashes];
    this.#rebases++;
    this.#changed();
    return { success: true, updated: true };
  }

  async #upload(): Promise<UploadResult> {
    const prepared = await this.#connection.remote.prepareSave();
    // Nothing changed since the version saved.
    if (prepared === null) return { success: true, sha256: this.sha256! };

    let result: UploadResult;
    try {
      result =
        prepared.previous === null
          ? await replaceDatabase(this.#token, prepared.part, { ifNoneMatch: true })
          : await appendDatabasePart(this.#token, prepared.part);
    } catch (error) {
      // The upload's error is what went wrong, whatever finishing says.
      await this.#change(() => this.#connection.remote.finishSave(false)).catch(() => {});
      throw error;
    }
    const { sha256 } = await this.#change(() => this.#connection.remote.finishSave(result.success));
    if (!result.success) return result;
    this.#hashes.push(sha256!);
    return { success: true, sha256: sha256! };
  }

  /**
   * The database as an SQLite file, as it is now: unsaved changes too, and
   * unencrypted. Doesn't change what's saved.
   */
  serialize() {
    return this.#connection.remote.serialize();
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
 * parts can't be read, decrypted or opened (its `code` is a
 * DatabasePartErrorCode for errors in the parts). Network failures throw.
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
  return openIn(started, session, download.success ? download.parts : null);
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
 * Opens the stored `parts` in `started`, or creates a new database if
 * they're null. Stops the worker if that fails.
 */
async function openIn(
  started: DatabaseWorker,
  session: Session,
  parts: Uint8Array<ArrayBuffer> | null,
) {
  let opened;
  try {
    opened = await started.connection.remote.open(parts && transfer(parts), session.kek);
  } catch (error) {
    stopWorker(started);
    throw error;
  }
  return new Database(started.worker, started.connection, session.token, opened);
}
