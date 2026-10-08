import { DurableObject } from "cloudflare:workers";
export class UserStore extends DurableObject {
  sql: SqlStorage;
  private initialized = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
  }

  private init() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key   TEXT NOT NULL PRIMARY KEY,
        value TEXT
      );`);
    this.initialized = true;
  }

  private async deinit() {
    await this.ctx.storage.deleteAll();
    this.initialized = false;
  }

  async alarm() {
    const lastLogin = this.sql
      .exec(
        `
        SELECT value FROM kv
        WHERE key = 'LastLogin';`,
      )
      .toArray();

    if (lastLogin.length === 0) await this.deinit();
  }

  async registerNewUser(
    registrationRecord: string,
  ): Promise<RegisterNewUserResponse> {
    if (!this.initialized) this.init();

    const cursor = this.sql.exec(
      `
      INSERT INTO kv (key, value)
      VALUES ('RegistrationRecord', ?)
      ON CONFLICT DO NOTHING;`,
      registrationRecord,
    );

    if (cursor.rowsWritten === 0)
      return { success: false, code: "USER_ALREADY_EXISTS" };

    // delete user in 24 hours if they do not login
    await this.ctx.storage.setAlarm(Date.now() + 1000 * 60 * 60 * 24);
    return { success: true };
  }
}

export type RegisterNewUserResponse =
  | { success: true }
  | { success: false; code: "USER_ALREADY_EXISTS" };
