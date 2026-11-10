import fs from "fs";
import path from "path";
import { describe, expect, inject, it } from "vitest";
import {
  editLocal,
  localDatabasePath,
  localFiles,
  localPartsPath,
  queryLocal,
  queryStored,
  saveElsewhere,
  storedPartCount,
  storedParts,
} from "./test/database.ts";
import { registered, run, sessionEnv, temporaryRoot, userDirectory } from "./test/run.ts";

const endpoint = inject("endpoint");

function pushDatabase(root: string, ...args: string[]) {
  return run("push-database", ["--root", root, ...args]);
}

function pullDatabase(root: string, ...args: string[]) {
  return run("pull-database", ["--root", root, ...args]);
}

function account(name: string, type = "Bank") {
  return `INSERT INTO accounts VALUES ('${name}', NULL, '${type}', NULL)`;
}

const ACCOUNTS = "SELECT name, type FROM accounts ORDER BY name";
const FILES = [".env", "database-parts", "database.sqlite3"];
const TABLES = ["currencies", "accounts", "sources", "categories", "transactions", "conversions"];

/** A registered user who has pulled their database, new and empty. */
async function pulled() {
  const root = temporaryRoot();
  const username = await registered(root, endpoint);
  const { exitCode, output } = await pullDatabase(root);
  if (exitCode !== 0) throw new Error(`Couldn't pull: ${output}`);
  return { root, username };
}

function localParts(root: string, username: string) {
  return new Uint8Array(fs.readFileSync(localPartsPath(root, username)));
}

/** The user's directory: each file's name and bytes. */
function snapshot(root: string, username: string) {
  return localFiles(root, username).map((name) => [
    name,
    fs.readFileSync(path.join(userDirectory(root, username), name)).toString("hex"),
  ]);
}

/** Replaces `value` with `replacement` in the user's .env. */
function editEnv(root: string, username: string, value: string, replacement: string) {
  const envPath = path.join(userDirectory(root, username), ".env");
  fs.writeFileSync(envPath, fs.readFileSync(envPath, "utf8").replace(value, replacement));
}

describe("push-database, without a terminal", () => {
  describe("uploading what was changed here", () => {
    it("stores the changes as a part after the last", async () => {
      const { root, username } = await pulled();
      editLocal(root, username, account("Local"));
      const database = fs.readFileSync(localDatabasePath(root, username));

      const { exitCode, output } = await pushDatabase(root);

      expect(output).toContain("Pushed the changes");
      expect(exitCode).toBe(0);
      expect(await storedPartCount(root, username)).toBe(2);
      expect(await queryStored(root, username, ACCOUNTS)).toEqual([["Local", "Bank"]]);
      // The parts here are again all that's stored, and the database is as it was.
      expect(localParts(root, username)).toEqual(await storedParts(root, username));
      expect(fs.readFileSync(localDatabasePath(root, username))).toEqual(database);
      expect(localFiles(root, username)).toEqual(FILES);
    });

    it("stores inserts, updates and deletes, and what triggers and foreign keys made of them", async () => {
      const root = temporaryRoot();
      const username = await registered(root, endpoint);
      await run("seed-database", ["--root", root, "--transactions", "60", "--brokerage"]);
      await pullDatabase(root);
      editLocal(
        root,
        username,
        `${account("Local")};
         UPDATE transactions SET remarks = 'changed here' WHERE rowid % 3 = 0;
         UPDATE accounts SET type = 'Card' WHERE name = 'High-Yield Savings';
         DELETE FROM transactions WHERE rowid % 4 = 0;`,
      );

      const { exitCode } = await pushDatabase(root);

      expect(exitCode).toBe(0);
      expect(await storedPartCount(root, username)).toBe(2);
      for (const table of TABLES) {
        const rows = `SELECT * FROM ${table} ORDER BY 1, 2`;
        expect(await queryStored(root, username, rows), table).toEqual(
          queryLocal(root, username, rows),
        );
      }
    });

    it("has nothing to push when nothing was changed", async () => {
      const { root, username } = await pulled();
      const before = snapshot(root, username);

      const { exitCode, output } = await pushDatabase(root);

      expect(output).toContain("Nothing to push");
      expect(exitCode).toBe(0);
      expect(await storedPartCount(root, username)).toBe(1);
      expect(snapshot(root, username)).toEqual(before);
    });

    it("has nothing to push when a change was changed back", async () => {
      const { root, username } = await pulled();
      editLocal(root, username, account("Local"));
      editLocal(root, username, "DELETE FROM accounts WHERE name = 'Local'");

      const { exitCode, output } = await pushDatabase(root);

      expect(output).toContain("Nothing to push");
      expect(exitCode).toBe(0);
      expect(await storedPartCount(root, username)).toBe(1);
    });

    it("has nothing to push again once the changes are pushed", async () => {
      const { root, username } = await pulled();
      editLocal(root, username, account("Local"));
      await pushDatabase(root);

      const { exitCode, output } = await pushDatabase(root);

      expect(output).toContain("Nothing to push");
      expect(exitCode).toBe(0);
      expect(await storedPartCount(root, username)).toBe(2);
    });

    it("pushes again what's changed after a push, as a part of its own", async () => {
      const { root, username } = await pulled();
      editLocal(root, username, account("First"));
      await pushDatabase(root);
      editLocal(root, username, "UPDATE accounts SET type = 'Card' WHERE name = 'First'");
      editLocal(root, username, account("Second"));

      const { exitCode } = await pushDatabase(root);

      expect(exitCode).toBe(0);
      expect(await storedPartCount(root, username)).toBe(3);
      expect(await queryStored(root, username, ACCOUNTS)).toEqual([
        ["First", "Card"],
        ["Second", "Bank"],
      ]);
      expect(localParts(root, username)).toEqual(await storedParts(root, username));
    });

    it("pushes changes to a file another program left in WAL mode", async () => {
      const { root, username } = await pulled();
      editLocal(root, username, `PRAGMA journal_mode = WAL; ${account("Local")}`);

      const { exitCode } = await pushDatabase(root);

      expect(exitCode).toBe(0);
      expect(await queryStored(root, username, ACCOUNTS)).toEqual([["Local", "Bank"]]);
    });

    it("leaves a pull after it with nothing new to bring in", async () => {
      const { root, username } = await pulled();
      editLocal(root, username, account("Local"));
      await pushDatabase(root);

      const { exitCode, output } = await pullDatabase(root);

      expect(output).toContain("is up to date");
      expect(exitCode).toBe(0);
      expect(localFiles(root, username)).toEqual(FILES);
    });

    it("pushes only --user's database when there's more than one user", async () => {
      const { root, username } = await pulled();
      const other = await registered(root, endpoint);
      await pullDatabase(root, "--user", other);
      editLocal(root, username, account("Mine"));
      editLocal(root, other, account("Theirs"));

      const { exitCode } = await pushDatabase(root, "--user", other);

      expect(exitCode).toBe(0);
      expect(await queryStored(root, other, ACCOUNTS)).toEqual([["Theirs", "Bank"]]);
      expect(await storedPartCount(root, username)).toBe(1);
    });
  });

  describe("when the stored database has changed since the pull", () => {
    it("fails pointing at pull-database, with nothing changed here or stored", async () => {
      const { root, username } = await pulled();
      editLocal(root, username, account("Local"));
      await saveElsewhere(root, username, account("Remote"));
      const before = snapshot(root, username);

      const { exitCode, output } = await pushDatabase(root);

      expect(output).toContain("npm run pull-database");
      expect(exitCode).toBe(1);
      expect(snapshot(root, username)).toEqual(before);
      expect(await storedPartCount(root, username)).toBe(2);
      expect(await queryStored(root, username, ACCOUNTS)).toEqual([["Remote", "Bank"]]);
    });

    it("pushes after a pull moved the changes onto the newer version", async () => {
      const { root, username } = await pulled();
      editLocal(root, username, account("Local"));
      await saveElsewhere(root, username, account("Remote"));
      await pushDatabase(root);
      await pullDatabase(root);

      const { exitCode } = await pushDatabase(root);

      expect(exitCode).toBe(0);
      expect(await storedPartCount(root, username)).toBe(3);
      expect(await queryStored(root, username, ACCOUNTS)).toEqual([
        ["Local", "Bank"],
        ["Remote", "Bank"],
      ]);
      expect(localParts(root, username)).toEqual(await storedParts(root, username));
    });

    it("fails pointing at pull-database when it was replaced by another", async () => {
      const { root, username } = await pulled();
      editLocal(root, username, account("Local"));
      await run("seed-database", [
        ...["--root", root, "--transactions", "5", "--no-brokerage", "--replace"],
      ]);
      const before = snapshot(root, username);

      const { exitCode, output } = await pushDatabase(root);

      expect(output).toContain("npm run pull-database");
      expect(exitCode).toBe(1);
      expect(snapshot(root, username)).toEqual(before);
      expect(await storedPartCount(root, username)).toBe(1);
    });

    it("gets past a push that stored its part but didn't get to keep it here", async () => {
      const { root, username } = await pulled();
      const olderParts = localParts(root, username);
      editLocal(root, username, account("Local"));
      await pushDatabase(root);
      // As if that push had stopped between storing the part and writing it here.
      fs.writeFileSync(localPartsPath(root, username), olderParts);

      const again = await pushDatabase(root);
      const pull = await pullDatabase(root);
      const afterPull = await pushDatabase(root);

      // The same changes aren't stored twice: they don't follow the last part.
      expect(again.exitCode).toBe(1);
      expect(again.output).toContain("npm run pull-database");
      // The pull finds them already made, and nothing is left to push.
      expect(pull.exitCode).toBe(0);
      expect(localFiles(root, username)).toEqual(FILES);
      expect(afterPull.output).toContain("Nothing to push");
      expect(await storedPartCount(root, username)).toBe(2);
      expect(await queryStored(root, username, ACCOUNTS)).toEqual([["Local", "Bank"]]);
    });
  });

  describe("failing, with nothing changed here or stored", () => {
    /** Runs the push, expecting it to fail saying `message` and change nothing. */
    async function expectUntouched(root: string, username: string, message: string) {
      const before = snapshot(root, username);
      const stored = await storedParts(root, username);

      const { exitCode, output } = await pushDatabase(root);

      expect(output).toContain(message);
      expect(exitCode).toBe(1);
      expect(snapshot(root, username)).toEqual(before);
      expect(await storedParts(root, username)).toEqual(stored);
    }

    it("when the database's tables were changed", async () => {
      const { root, username } = await pulled();
      editLocal(root, username, `CREATE TABLE notes (text TEXT); ${account("Local")}`);

      await expectUntouched(root, username, "tables, indexes or triggers were changed");
    });

    it("when a column was added to a table", async () => {
      const { root, username } = await pulled();
      editLocal(root, username, "ALTER TABLE accounts ADD COLUMN note TEXT");

      await expectUntouched(root, username, "tables, indexes or triggers were changed");
    });

    it("when a trigger was dropped", async () => {
      const { root, username } = await pulled();
      editLocal(root, username, "DROP TRIGGER no_category_loop_on_insert");

      await expectUntouched(root, username, "tables, indexes or triggers were changed");
    });

    it("when the database isn't a database", async () => {
      const { root, username } = await pulled();
      fs.writeFileSync(localDatabasePath(root, username), "not a database, but somebody's notes");

      await expectUntouched(root, username, "isn't an SQLite database");
    });

    it("when another program still holds changes in a -wal file", async () => {
      const { root, username } = await pulled();
      editLocal(root, username, account("Local"));
      fs.writeFileSync(`${localDatabasePath(root, username)}-wal`, "changes not in the file yet");

      await expectUntouched(root, username, "database.sqlite3-wal");
    });

    it("when the database was never pulled", async () => {
      const root = temporaryRoot();
      const username = await registered(root, endpoint);

      const { exitCode, output } = await pushDatabase(root);

      expect(output).toContain("npm run pull-database");
      expect(exitCode).toBe(1);
      expect(localFiles(root, username)).toEqual([".env"]);
      expect(await storedParts(root, username)).toBeNull();
    });

    it("when the database is gone", async () => {
      const { root, username } = await pulled();
      fs.rmSync(localDatabasePath(root, username));

      await expectUntouched(root, username, "npm run pull-database");
    });

    it("when the parts the database was made from are gone", async () => {
      const { root, username } = await pulled();
      editLocal(root, username, account("Local"));
      fs.rmSync(localPartsPath(root, username));

      await expectUntouched(root, username, "npm run pull-database");
    });

    it("when the parts the database was made from aren't parts", async () => {
      const { root, username } = await pulled();
      editLocal(root, username, account("Local"));
      fs.writeFileSync(localPartsPath(root, username), "not parts");

      await expectUntouched(root, username, "npm run pull-database");
    });

    it("when the parts were encrypted under another key", async () => {
      const { root, username } = await pulled();
      editLocal(root, username, account("Local"));
      const kek = sessionEnv(root, username).SPENDY2_KEK!;
      editEnv(root, username, kek, Buffer.alloc(32, 7).toString("base64url"));
      const before = snapshot(root, username);

      const { exitCode, output } = await pushDatabase(root);

      expect(output).toContain("database-parts can't be read");
      expect(exitCode).toBe(1);
      expect(snapshot(root, username)).toEqual(before);
      editEnv(root, username, Buffer.alloc(32, 7).toString("base64url"), kek);
      expect(await storedPartCount(root, username)).toBe(1);
    });

    it("when the session has ended", async () => {
      const { root, username } = await pulled();
      editLocal(root, username, account("Local"));
      const token = sessionEnv(root, username).SPENDY2_TOKEN!;
      editEnv(root, username, token, "ended");
      const before = snapshot(root, username);

      const { exitCode, output } = await pushDatabase(root);

      expect(output).toContain("The session has ended");
      expect(exitCode).toBe(1);
      expect(snapshot(root, username)).toEqual(before);
      editEnv(root, username, "ended", token);
      expect(await storedPartCount(root, username)).toBe(1);
    });

    it("when the server can't be reached", async () => {
      const { root, username } = await pulled();
      editLocal(root, username, account("Local"));
      // Port 9 (discard): nothing listens there.
      editEnv(root, username, endpoint, "http://127.0.0.1:9/");
      const before = snapshot(root, username);

      const { exitCode, output } = await pushDatabase(root);

      expect(output).toContain("Could not reach");
      expect(exitCode).toBe(1);
      expect(snapshot(root, username)).toEqual(before);
    });

    it("when there's more than one user and no --user", async () => {
      const { root, username } = await pulled();
      await registered(root, endpoint);
      editLocal(root, username, account("Local"));

      await expectUntouched(root, username, "--user is required");
    });
  });
});
