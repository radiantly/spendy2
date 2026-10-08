import { DurableObject } from "cloudflare:workers";
import * as opaque from "@serenity-kit/opaque";

class RegistrationRecordStore {
  private readonly sql;
  constructor(sql: SqlStorage) {
    this.sql = sql;
  }

  get tableExists() {
    return (
      this.sql
        .exec(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'registration_record';",
        )
        .toArray().length > 0
    );
  }

  set(registrationRecord: string) {
    const { record } = this.sql
      .exec<{ record: string }>(
        `
        CREATE TABLE IF NOT EXISTS registration_record (
          id      INTEGER NOT NULL PRIMARY KEY CHECK (id = 0),
          record  TEXT NOT NULL
        );

        INSERT INTO registration_record (id, record) VALUES (0, ?)
        ON CONFLICT (id) DO UPDATE
          SET id = id
        RETURNING record`,
        registrationRecord,
      )
      .one();

    return record === registrationRecord;
  }

  get() {
    if (!this.tableExists) return;

    const { record } = this.sql
      .exec<{ record: string }>("SELECT record FROM registration_record")
      .one();

    return record;
  }
}

class SessionStore {
  private readonly sql;
  private readonly maxSessionCount;
  constructor(sql: SqlStorage, maxSessionCount: number) {
    this.sql = sql;
    this.maxSessionCount = maxSessionCount;
  }

  get tableExists() {
    return (
      this.sql
        .exec(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions';",
        )
        .toArray().length > 0
    );
  }

  has(sessionId: string) {
    if (!this.tableExists) return false;

    return (
      this.sql.exec("SELECT 1 FROM sessions WHERE id = ?", sessionId).toArray()
        .length > 0
    );
  }

  create() {
    const sessionId = crypto.randomUUID();
    this.sql.exec(
      `
      CREATE TABLE IF NOT EXISTS sessions (
        id              TEXT NOT NULL PRIMARY KEY,
        created_at      INTEGER NOT NULL
      );
      
      INSERT INTO sessions (id, created_at) VALUES (?, ?);`,
      sessionId,
      Date.now(),
    );

    // delete the oldest session if the number of sessions exceed the max session count
    this.sql.exec(
      `
      DELETE FROM sessions WHERE id NOT IN (
        SELECT id FROM sessions ORDER BY created_at DESC, rowid DESC LIMIT ?
      );`,
      this.maxSessionCount,
    );
    return sessionId;
  }

  delete(sessionId: string) {
    if (!this.tableExists) return false;

    let cursor = this.sql.exec(`DELETE FROM sessions WHERE id = ?;`, sessionId);
    return cursor.rowsWritten > 0;
  }
}

export class UserStore extends DurableObject<Env> {
  sql: SqlStorage;
  private _registrationRecord?: RegistrationRecordStore;
  private _sessions?: SessionStore;

  // for login
  private loginState?: string;
  private loginOnlyAfter = 0;
  private loginAttempts = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
  }

  private get registrationRecord() {
    if (this._registrationRecord === undefined)
      this._registrationRecord = new RegistrationRecordStore(this.sql);
    return this._registrationRecord;
  }

  private get sessions() {
    if (this._sessions === undefined)
      this._sessions = new SessionStore(
        this.sql,
        this.env.MAX_SESSIONS_PER_USER,
      );
    return this._sessions;
  }

  private get username() {
    const name = this.ctx.id.name;
    if (name === undefined)
      throw new Error("UserStore must be addressed by name");
    return name;
  }

  async alarm() {
    // TODO: delete registration record
  }

  async registerNewUser(
    registrationRecord: string,
  ): Promise<RegisterNewUserResponse> {
    if (!this.registrationRecord.set(registrationRecord))
      return { success: false, code: "USER_ALREADY_EXISTS" };

    // delete user if they do not login
    await this.ctx.storage.setAlarm(
      Date.now() + this.env.USER_CLEANUP_DELAY_SECONDS * 1000,
    );
    return { success: true };
  }

  private startLogin(startLoginRequest: string) {
    const userIdentifier = this.username;
    const registrationRecord = this.registrationRecord.get();

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

  async startLoginRatelimited(
    startLoginRequest: string,
  ): Promise<StartLoginResponse> {
    await opaque.ready;

    const now = Date.now();
    if (now < this.loginOnlyAfter)
      return { success: false, code: "RATE_LIMITED" };

    const loginResponse = this.startLogin(startLoginRequest);

    if (loginResponse === undefined)
      return { success: false, code: "INVALID_REQUEST" };

    const maxDelay = Math.min(
      2 ** ++this.loginAttempts,
      this.env.LOGIN_BACKOFF_MAX_SECONDS,
    );
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

    const sessionId = this.sessions.create();
    return { success: true, sessionId };
  }

  async logout(sessionId: string): Promise<LogoutResponse> {
    if (!this.sessions.delete(sessionId))
      return { success: false, code: "UNAUTHORIZED" };
    return { success: true };
  }
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

export type LogoutResponse =
  | { success: true }
  | { success: false; code: "UNAUTHORIZED" };
