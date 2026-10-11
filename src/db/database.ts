import type { BindingSpec } from "@sqlite.org/sqlite-wasm";
import {
  downloadDatabase,
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
 */
export class Database {
  readonly #worker: Worker;
  readonly #connection: Connection<DatabaseApi>;
  readonly #token: string;
  #sha256: string | null;
  /** Settles when the latest save has; saves run one at a time. */
  #saving: Promise<unknown> = Promise.resolve();

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

  query(sql: string, bind?: BindingSpec) {
    return this.#connection.remote.query(sql, bind);
  }

  /** Runs the statements in one transaction: all of them, or none if one fails. */
  batch(statements: Statement[]) {
    return this.#connection.remote.batch(statements);
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
    const result = await uploadDatabase(
      this.#token,
      blob,
      this.#sha256 === null ? { ifNoneMatch: true } : { ifMatch: this.#sha256 },
    );
    if (result.success) this.#sha256 = result.sha256;
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
  const download = await downloadDatabase(session.token);
  if (!download.success && download.code !== "NOT_FOUND")
    throw new DatabaseOpenError(download.code);
  const stored = download.success ? download : null;

  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  const connection = connect<DatabaseApi>(worker);
  try {
    await connection.remote.open(stored && transfer(stored.blob), session.kek);
  } catch (error) {
    connection.close();
    worker.terminate();
    throw error;
  }
  return new Database(worker, connection, session.token, stored?.sha256 ?? null);
}
