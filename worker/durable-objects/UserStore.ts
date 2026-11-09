import { DurableObject } from "cloudflare:workers";
import * as opaque from "@serenity-kit/opaque";
import type { z } from "zod";
import {
  partChainError,
  readParts,
  type PartChainError,
  type PartFormatError,
} from "../databaseParts.ts";
import {
  DATABASE_UPDATES_CLOSE,
  databaseUpdatesAuthSchema,
  tokenSchema,
  type databaseUpdateSchema,
} from "../schemas.ts";
import { StoredDatabase } from "./StoredDatabase.ts";

/**
 * What a socket watching the database keeps through hibernation: the
 * session it authenticated as, null until it has.
 */
type SocketAttachment = { sessionId: string | null };

const sessionOf = (ws: WebSocket) => (ws.deserializeAttachment() as SocketAttachment).sessionId;

/** Closes `ws` for not being, or no longer being, an active session's. */
const closeUnauthorized = (ws: WebSocket) =>
  ws.close(DATABASE_UPDATES_CLOSE.UNAUTHORIZED, "UNAUTHORIZED");

export class UserStore extends DurableObject<Env> {
  // for login
  private loginState?: string;
  private loginOnlyAfter = 0;
  private loginAttempts = 0;

  private readonly database = new StoredDatabase(this.ctx.storage);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // A client's keepalive, answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

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
    if (this.database.lastPart() !== undefined) return;
    await this.ctx.storage.deleteAll();
    // The user is gone, and every session with them.
    for (const ws of this.ctx.getWebSockets()) closeUnauthorized(ws);
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
    // The session it pushed out, if any, is over.
    this.closeEndedSockets();

    return { success: true, sessionId };
  }

  async logout(sessionId: string): Promise<LogoutResponse> {
    const sessions = this.getKv("ACTIVE_SESSIONS") ?? new Set();
    if (!sessions.delete(sessionId)) return { success: false, code: "UNAUTHORIZED" };
    this.putKv("ACTIVE_SESSIONS", sessions);
    this.closeEndedSockets();
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
  ): Promise<ReplaceDatabaseResponse> {
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
    this.sendUpdate();
    return { success: true, sha256: parts.at(-1)!.hash };
  }

  /**
   * Adds the part `stream` holds after the last part, which it must follow
   * (its AAD names the part before it). CONFLICT if it doesn't, as when it
   * was made from another version of the database, or if there's no
   * database: only replaceDatabase can create one.
   */
  async appendDatabasePart(
    sessionId: string,
    stream: ReadableStream<Uint8Array>,
  ): Promise<AppendDatabasePartResponse> {
    if (!this.isActiveSession(sessionId)) return { success: false, code: "UNAUTHORIZED" };

    const read = await readParts(new Uint8Array(await new Response(stream).arrayBuffer()));
    if (!read.success) return read;
    // one part, so its length is the body's
    if (read.parts.length !== 1) return { success: false, code: "INVALID_PART_LENGTH" };
    const [part] = read.parts;

    // no await from here on, so nothing is stored between the check and the write
    const last = this.database.lastPart();
    if (last === undefined) return { success: false, code: "CONFLICT" };
    const code = partChainError(part, last);
    if (code === "BROKEN_PART_CHAIN") return { success: false, code: "CONFLICT" };
    if (code !== undefined) return { success: false, code };

    this.database.append(part);
    this.sendUpdate();
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

  /**
   * Opens a socket that watches the database (see routes/users/updates.ts).
   * It's sent nothing until its first message authenticates it, which must
   * come within SOCKET_AUTH_TIMEOUT_SECONDS.
   */
  async fetch() {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ sessionId: null } satisfies SocketAttachment);
    // A timer keeps the object from hibernating until then, so it fires.
    setTimeout(() => {
      if (sessionOf(server) === null)
        server.close(DATABASE_UPDATES_CLOSE.AUTH_TIMEOUT, "AUTH_TIMEOUT");
    }, this.env.SOCKET_AUTH_TIMEOUT_SECONDS * 1000);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * A socket's first message authenticates it, as an active session of this
   * user; the socket is closed if it doesn't. Once it has, it's sent the
   * database's last part, and anything else it sends is ignored.
   */
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (sessionOf(ws) !== null) return;
    const sessionId = this.sessionAuthenticatedBy(message);
    if (sessionId === null) return closeUnauthorized(ws);
    ws.serializeAttachment({ sessionId } satisfies SocketAttachment);
    ws.send(this.updateMessage());
  }

  /** The active session of this user `message` authenticates as, if it does. */
  private sessionAuthenticatedBy(message: string | ArrayBuffer) {
    if (typeof message !== "string") return null;
    let json: unknown;
    try {
      json = JSON.parse(message);
    } catch {
      return null;
    }
    const auth = databaseUpdatesAuthSchema.safeParse(json);
    if (!auth.success) return null;
    const token = tokenSchema.safeDecode(auth.data.token);
    if (!token.success || token.data.username !== this.username) return null;
    return this.isActiveSession(token.data.sessionId) ? token.data.sessionId : null;
  }

  /** What a socket is told of the database: its last part, as it is now. */
  private updateMessage() {
    const last = this.database.lastPart();
    const update: z.input<typeof databaseUpdateSchema> = {
      latestPart: last === undefined ? null : { index: last.part, hash: last.hash },
    };
    return JSON.stringify(update);
  }

  /** Tells every authenticated socket the database's last part, after it changed. */
  private sendUpdate() {
    const message = this.updateMessage();
    for (const ws of this.ctx.getWebSockets()) if (sessionOf(ws) !== null) ws.send(message);
  }

  /** Closes the authenticated sockets whose sessions have ended. */
  private closeEndedSockets() {
    const sessions = this.getKv("ACTIVE_SESSIONS") ?? new Set();
    for (const ws of this.ctx.getWebSockets()) {
      const sessionId = sessionOf(ws);
      if (sessionId !== null && !sessions.has(sessionId)) closeUnauthorized(ws);
    }
  }
}

interface KvSchema {
  REGISTRATION_RECORD: string;
  ACTIVE_SESSIONS: Set<string>;
}

/** `sha256` is the last part's, the ETag of the whole database. */
export type ReplaceDatabaseResponse =
  | { success: true; sha256: string }
  | {
      success: false;
      code: "UNAUTHORIZED" | PartFormatError | PartChainError | "PRECONDITION_FAILED";
    };

/**
 * `sha256` is the part's, now the last, the ETag of the whole database. A
 * part that doesn't follow the last is a CONFLICT, not a BROKEN_PART_CHAIN.
 */
export type AppendDatabasePartResponse =
  | { success: true; sha256: string }
  | {
      success: false;
      code: "UNAUTHORIZED" | PartFormatError | "USER_VERSION_DECREASED" | "CONFLICT";
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
