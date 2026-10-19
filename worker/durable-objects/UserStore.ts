import { DurableObject } from "cloudflare:workers";
import * as opaque from "@serenity-kit/opaque";
import { databaseBlobSchema, toSha256Schema } from "../schemas.ts";

// Maximum BLOB size for durable object is 2MB. Thus DB is stored in 1MiB chunks
export const DATABASE_CHUNK_BYTES = 1024 * 1024;

export class UserStore extends DurableObject<Env> {
  // for login
  private loginState?: string;
  private loginOnlyAfter = 0;
  private loginAttempts = 0;

  private getKv<K extends keyof KvSchema>(key: K): KvSchema[K] | undefined {
    return this.ctx.storage.kv.get<KvSchema[K]>(key);
  }

  private putKv<K extends keyof KvSchema>(key: K, value: KvSchema[K]) {
    return this.ctx.storage.kv.put(key, value);
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

  async uploadDatabase(
    sessionId: string,
    stream: ReadableStream<Uint8Array>,
    current_hash: string | null,
  ): Promise<UploadDatabaseResponse> {
    const sessions = this.getKv("ACTIVE_SESSIONS") ?? new Set();
    if (!sessions.has(sessionId)) return { success: false, code: "UNAUTHORIZED" };

    const body = await new Response(stream).arrayBuffer();
    const header = databaseBlobSchema.safeDecode(body);
    if (!header.success) {
      // A wrong magic also fails the version check; the first issue is the cause.
      const cause = header.error.issues[0]?.message;
      return {
        success: false,
        code: cause === "INVALID_VERSION_BYTE" ? "INVALID_VERSION_BYTE" : "MISSING_SPENDY_MAGIC",
      };
    }
    const sha256 = await toSha256Schema.decodeAsync(body);

    if ((this.getKv("DATABASE_SHA256") ?? null) !== current_hash)
      return { success: false, code: "PRECONDITION_FAILED" };

    this.ctx.storage.transactionSync(() => {
      const { sql } = this.ctx.storage;
      sql.exec(`
        DROP TABLE IF EXISTS database_chunks;
        CREATE TABLE database_chunks (
          seq  INTEGER PRIMARY KEY, -- position, from 0
          data BLOB NOT NULL        -- at most DATABASE_CHUNK_BYTES
        ) STRICT;
        `);
      for (let seq = 0; seq * DATABASE_CHUNK_BYTES < body.byteLength; seq++) {
        const start = seq * DATABASE_CHUNK_BYTES;
        sql.exec(
          "INSERT INTO database_chunks (seq, data) VALUES (?, ?)",
          seq,
          body.slice(start, start + DATABASE_CHUNK_BYTES),
        );
      }
      this.putKv("DATABASE_SHA256", sha256);
    });
    return { success: true, sha256 };
  }

  async downloadDatabase(
    sessionId: string,
    current_hash: string | null,
  ): Promise<DownloadDatabaseResponse> {
    const sessions = this.getKv("ACTIVE_SESSIONS") ?? new Set();
    if (!sessions.has(sessionId)) return { success: false, code: "UNAUTHORIZED" };

    const current = this.getKv("DATABASE_SHA256");
    if (current === undefined) return { success: false, code: "NOT_FOUND" };
    if (current === current_hash) return { success: true, modified: false, sha256: current };

    const chunks = this.ctx.storage.sql
      .exec<{ data: ArrayBuffer }>("SELECT data FROM database_chunks ORDER BY seq")
      .toArray();
    const body = new Uint8Array(chunks.reduce((size, { data }) => size + data.byteLength, 0));
    let offset = 0;
    for (const { data } of chunks) {
      body.set(new Uint8Array(data), offset);
      offset += data.byteLength;
    }
    return { success: true, modified: true, body: body.buffer, sha256: current };
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
      code:
        | "UNAUTHORIZED"
        | "MISSING_SPENDY_MAGIC"
        | "INVALID_VERSION_BYTE"
        | "PRECONDITION_FAILED";
    };

export type DownloadDatabaseResponse =
  | { success: true; modified: true; body: ArrayBuffer; sha256: string }
  | { success: true; modified: false; sha256: string }
  | { success: false; code: "UNAUTHORIZED" | "NOT_FOUND" };

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
