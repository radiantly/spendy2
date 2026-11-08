import { DurableObject } from "cloudflare:workers";
import * as opaque from "@serenity-kit/opaque";
import {
  partChainError,
  readParts,
  type PartChainError,
  type PartFormatError,
} from "../databaseParts.ts";
import { StoredDatabase } from "./StoredDatabase.ts";

export class UserStore extends DurableObject<Env> {
  // for login
  private loginState?: string;
  private loginOnlyAfter = 0;
  private loginAttempts = 0;

  private readonly database = new StoredDatabase(this.ctx.storage);

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
    if (this.database.lastPart() === undefined) await this.ctx.storage.deleteAll();
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

    // sessions are ordered by recency, where the first is the newest
    this.putKv(
      "ACTIVE_SESSIONS",
      new Set([sessionId, ...sessions.values().take(this.env.MAX_SESSIONS_PER_USER - 1)]),
    );

    return { success: true, sessionId };
  }

  async logout(sessionId: string): Promise<LogoutResponse> {
    const sessions = this.getKv("ACTIVE_SESSIONS") ?? new Set();
    if (!sessions.delete(sessionId)) return { success: false, code: "UNAUTHORIZED" };
    this.putKv("ACTIVE_SESSIONS", sessions);
    return { success: true };
  }

  private isActiveSession(sessionId: string) {
    // get active sessions and check for sessionId
    const sessions = this.getKv("ACTIVE_SESSIONS") ?? new Set();
    if (!sessions.has(sessionId)) return false;

    // the sessions set is roughly ordered by recency
    // make sure that this session is not in danger of being evicted
    const sessionIdx = [...sessions].indexOf(sessionId);
    if (sessionIdx >= this.env.MAX_SESSIONS_PER_USER / 2)
      this.putKv("ACTIVE_SESSIONS", new Set([sessionId, ...sessions]));

    return true;
  }

  /**
   * Replaces the database with the parts `stream` holds, which must chain
   * from part 0. `ifMatch` is the sha256 of the last part replaced, or null
   * if there must be no database yet.
   */
  async replaceDatabase(
    sessionId: string,
    stream: ReadableStream<Uint8Array>,
    ifMatch: string | null,
  ): Promise<UploadDatabaseResponse> {
    if (!this.isActiveSession(sessionId)) return { success: false, code: "UNAUTHORIZED" };

    const read = await readParts(new Uint8Array(await new Response(stream).arrayBuffer()));
    if (!read.success) return read;
    const { parts } = read;
    for (const [i, part] of parts.entries()) {
      const code = partChainError(part, i === 0 ? undefined : parts[i - 1]);
      if (code !== undefined) return { success: false, code };
    }

    // no await from here on, so nothing is stored between the check and the write
    if ((this.database.lastPart()?.hash ?? null) !== ifMatch)
      return { success: false, code: "PRECONDITION_FAILED" };

    this.database.replace(parts);
    return { success: true, sha256: parts.at(-1)!.hash };
  }

  /**
   * Adds the part `stream` holds after the last part, whose sha256
   * `ifMatch` must be. Only replaceDatabase can create a database.
   */
  async appendDatabasePart(
    sessionId: string,
    stream: ReadableStream<Uint8Array>,
    ifMatch: string,
  ): Promise<UploadDatabaseResponse> {
    if (!this.isActiveSession(sessionId)) return { success: false, code: "UNAUTHORIZED" };

    const read = await readParts(new Uint8Array(await new Response(stream).arrayBuffer()));
    if (!read.success) return read;
    // one part, so its length is the body's
    if (read.parts.length !== 1) return { success: false, code: "INVALID_PART_LENGTH" };
    const [part] = read.parts;

    // no await from here on, so nothing is stored between the check and the write
    const last = this.database.lastPart();
    if (last?.hash !== ifMatch) return { success: false, code: "PRECONDITION_FAILED" };
    const code = partChainError(part, last);
    if (code !== undefined) return { success: false, code };

    this.database.append(part);
    return { success: true, sha256: part.hash };
  }

  /**
   * Every part, one after the other, unless `ifNoneMatch` is the last part's
   * sha256. The body streams the parts as they are now, and errors if a
   * replace drops them before it's read.
   */
  async downloadDatabase(
    sessionId: string,
    ifNoneMatch: string | null,
  ): Promise<DownloadDatabaseResponse> {
    if (!this.isActiveSession(sessionId)) return { success: false, code: "UNAUTHORIZED" };

    const last = this.database.lastPart();
    if (last === undefined) return { success: false, code: "NOT_FOUND" };
    if (last.hash === ifNoneMatch) return { success: true, modified: false, sha256: last.hash };

    const { stream, byteLength } = this.database.streamAll();
    return { success: true, modified: true, body: stream, byteLength, sha256: last.hash };
  }

  /**
   * The part at `index`, counting from 0. The body errors if a replace drops
   * the part before it's read.
   */
  async downloadDatabasePart(
    sessionId: string,
    index: number,
  ): Promise<DownloadDatabasePartResponse> {
    if (!this.isActiveSession(sessionId)) return { success: false, code: "UNAUTHORIZED" };

    const part = this.database.streamPart(index);
    if (part === undefined) return { success: false, code: "NOT_FOUND" };
    return { success: true, body: part.stream, byteLength: part.byteLength, sha256: part.hash };
  }
}

interface KvSchema {
  REGISTRATION_RECORD: string;
  ACTIVE_SESSIONS: Set<string>;
}

/** `sha256` is the last part's, the ETag of the whole database. */
export type UploadDatabaseResponse =
  | { success: true; sha256: string }
  | {
      success: false;
      code: "UNAUTHORIZED" | PartFormatError | PartChainError | "PRECONDITION_FAILED";
    };

/** `sha256` is the last part's, the ETag of the whole database. */
export type DownloadDatabaseResponse =
  | ({ success: true; modified: true; sha256: string } & StreamedBody)
  | { success: true; modified: false; sha256: string }
  | { success: false; code: "UNAUTHORIZED" | "NOT_FOUND" };

export type DownloadDatabasePartResponse =
  | ({ success: true; sha256: string } & StreamedBody)
  | { success: false; code: "UNAUTHORIZED" | "NOT_FOUND" };

/** A body that's streamed, and how many bytes it has. */
interface StreamedBody {
  body: ReadableStream<Uint8Array>;
  byteLength: number;
}

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
