import { DurableObject } from "cloudflare:workers";
import * as opaque from "@serenity-kit/opaque";
import { S3, S3Error } from "../s3.ts";
import type { DatabasePutPrecondition } from "../schemas.ts";

export class UserStore extends DurableObject<Env> {
  // for login
  private loginState?: string;
  private loginOnlyAfter = 0;
  private loginAttempts = 0;

  // for database uploads/downloads
  private readonly s3: S3;
  private databaseLock: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.s3 = new S3(env);
  }

  private getKv<K extends keyof KvSchema>(key: K): KvSchema[K] | undefined {
    return this.ctx.storage.kv.get<KvSchema[K]>(key);
  }

  private putKv<K extends keyof KvSchema>(key: K, value: KvSchema[K]) {
    return this.ctx.storage.kv.put(key, value);
  }

  private deleteKv<K extends keyof KvSchema>(key: K) {
    return this.ctx.storage.kv.delete(key);
  }

  /**
   * Runs fn after every previously started fn has settled. The durable object
   * accepts other requests while awaiting object storage, so check-then-write
   * sequences on the database must hold this lock.
   */
  private withDatabaseLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.databaseLock.then(fn);
    this.databaseLock = result.catch(() => {});
    return result;
  }

  private get username() {
    const name = this.ctx.id.name;
    if (name === undefined) throw new Error("UserStore must be addressed by name");
    return name;
  }

  async alarm() {
    if (this.getKv("DATABASE_SHA256") === undefined) await this.ctx.storage.deleteAll();
  }

  async registerNewUser(registrationRecord: string): Promise<RegisterNewUserResponse> {
    const currentRecord = this.getKv("REGISTRATION_RECORD");
    if (currentRecord !== undefined) return { success: false, code: "USER_ALREADY_EXISTS" };

    this.putKv("REGISTRATION_RECORD", registrationRecord);

    // delete user if they do not create any data
    await this.ctx.storage.setAlarm(Date.now() + this.env.USER_CLEANUP_DELAY_SECONDS * 1000);
    return { success: true };
  }

  private startLogin(startLoginRequest: string) {
    const userIdentifier = this.username;
    const registrationRecord = this.getKv("REGISTRATION_RECORD");

    let result: opaque.server.LoginStartResult;
    try {
      result = opaque.server.startLogin({
        serverSetup: this.env.OPAQUE_SERVER_SETUP,
        userIdentifier,
        registrationRecord,
        startLoginRequest,
      });
    } catch {
      return;
    }

    this.loginState = result.serverLoginState;
    return result.loginResponse;
  }

  async startLoginRatelimited(startLoginRequest: string): Promise<StartLoginResponse> {
    await opaque.ready;

    const now = Date.now();
    if (now < this.loginOnlyAfter) return { success: false, code: "RATE_LIMITED" };

    const loginResponse = this.startLogin(startLoginRequest);

    if (loginResponse === undefined) return { success: false, code: "INVALID_REQUEST" };

    const maxDelay = Math.min(2 ** ++this.loginAttempts, this.env.LOGIN_BACKOFF_MAX_SECONDS);
    const delayMs = 1000 + Math.random() * (maxDelay - 1) * 1000;
    this.loginOnlyAfter = now + delayMs;

    return { success: true, loginResponse };
  }

  async finishLogin(finishLoginRequest: string): Promise<FinishLoginResponse> {
    await opaque.ready;

    if (this.loginState === undefined)
      return { success: false, code: "INVALID_LOGIN_OR_TIMED_OUT" };

    const serverLoginState = this.loginState;
    this.loginState = undefined;

    try {
      opaque.server.finishLogin({ serverLoginState, finishLoginRequest });
    } catch {
      return { success: false, code: "INVALID_LOGIN" };
    }

    this.loginAttempts = 0;
    this.loginOnlyAfter = 0;

    // get active sessions
    const sessions = this.getKv("ACTIVE_SESSIONS") ?? new Set();
    const sessionId = crypto.randomUUID();
    sessions.add(sessionId);

    // delete oldest session if it has crossed MAX_SESSIONS_PER_USER
    for (const session of sessions) {
      if (sessions.size <= this.env.MAX_SESSIONS_PER_USER) break;
      sessions.delete(session);
    }
    this.putKv("ACTIVE_SESSIONS", sessions);

    return { success: true, sessionId };
  }

  async logout(sessionId: string): Promise<LogoutResponse> {
    const sessions = this.getKv("ACTIVE_SESSIONS") ?? new Set();
    if (!sessions.delete(sessionId)) return { success: false, code: "UNAUTHORIZED" };
    this.putKv("ACTIVE_SESSIONS", sessions);
    return { success: true };
  }

  private get databaseBlobName() {
    return this.username + ".db.gz.enc";
  }

  async uploadDatabase(
    sessionId: string,
    precondition: DatabasePutPrecondition,
    body: ArrayBuffer,
    sha256: string,
  ): Promise<UploadDatabaseResponse> {
    const sessions = this.getKv("ACTIVE_SESSIONS") ?? new Set();
    if (!sessions.has(sessionId)) return { success: false, code: "UNAUTHORIZED" };

    return this.withDatabaseLock(async () => {
      const current = this.getKv("DATABASE_SHA256");
      const precondition_satisfied =
        "if-none-match" in precondition
          ? current === undefined
          : current === precondition["if-match"];
      if (!precondition_satisfied) return { success: false, code: "PRECONDITION_FAILED" };

      try {
        await this.s3.put(this.databaseBlobName, body, sha256);
      } catch (error) {
        if (error instanceof S3Error) return { success: false, code: "STORAGE_ERROR" };
        throw error;
      }

      this.putKv("DATABASE_SHA256", sha256);
      return { success: true, sha256 };
    });
  }

  /**
   * With `ifNoneMatch`, the sha256 of the version the client has: if it's
   * still the current one, there's nothing to send. That's decided from the
   * stored hash alone, so checking for changes never reaches object storage.
   */
  async downloadDatabase(
    sessionId: string,
    ifNoneMatch?: string,
  ): Promise<DownloadDatabaseResponse> {
    const sessions = this.getKv("ACTIVE_SESSIONS") ?? new Set();
    if (!sessions.has(sessionId)) return { success: false, code: "UNAUTHORIZED" };

    // the lock is only held until the response headers arrive, the body is
    // streamed afterwards
    return this.withDatabaseLock(async () => {
      const current = this.getKv("DATABASE_SHA256");
      if (ifNoneMatch !== undefined && current === ifNoneMatch)
        return { success: true, modified: false, sha256: current };

      let blob;
      try {
        blob = await this.s3.get(this.databaseBlobName);
      } catch (error) {
        if (error instanceof S3Error) return { success: false, code: "STORAGE_ERROR" };
        throw error;
      }

      if (blob === undefined) {
        this.deleteKv("DATABASE_SHA256");
        return { success: false, code: "NOT_FOUND" };
      }
      this.putKv("DATABASE_SHA256", blob.sha256);

      return { success: true, modified: true, body: blob.body, sha256: blob.sha256 };
    });
  }
}

interface KvSchema {
  REGISTRATION_RECORD: string;
  ACTIVE_SESSIONS: Set<string>;
  DATABASE_SHA256: string;
}

export type UploadDatabaseResponse =
  | { success: true; sha256: string }
  | {
      success: false;
      code: "UNAUTHORIZED" | "PRECONDITION_FAILED" | "STORAGE_ERROR";
    };

export type DownloadDatabaseResponse =
  | { success: true; modified: true; body: ReadableStream<Uint8Array>; sha256: string }
  | { success: true; modified: false; sha256: string }
  | { success: false; code: "UNAUTHORIZED" | "NOT_FOUND" | "STORAGE_ERROR" };

export type RegisterNewUserResponse =
  | { success: true }
  | { success: false; code: "USER_ALREADY_EXISTS" };

export type StartLoginResponse =
  | { success: true; loginResponse: string }
  | { success: false; code: "RATE_LIMITED" | "INVALID_REQUEST" };

export type FinishLoginResponse =
  | { success: true; sessionId: string }
  | { success: false; code: "INVALID_LOGIN_OR_TIMED_OUT" | "INVALID_LOGIN" };

export type LogoutResponse = { success: true } | { success: false; code: "UNAUTHORIZED" };
