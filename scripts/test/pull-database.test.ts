import fs from "fs";
import path from "path";
import { describe, expect, inject, it } from "vitest";
import {
  LATEST_VERSION,
  editLocal,
  localDatabasePath,
  localFiles,
  localPartsPath,
  queryLocal,
  queryStored,
  saveElsewhere,
  storedPartCount,
  storedParts,
} from "./database.ts";
import { registered, run, sessionEnv, temporaryRoot, userDirectory } from "./run.ts";

const endpoint = inject("endpoint");

function pullDatabase(root: string, ...args: string[]) {
  return run("pull-database", ["--root", root, ...args]);
}

function account(name: string, type = "Bank") {
  return `INSERT INTO accounts VALUES ('${name}', NULL, '${type}', NULL)`;
}

const ACCOUNTS = "SELECT name, type FROM accounts ORDER BY name";
const FILES = [".env", "database-parts", "database.sqlite3"];

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

describe("pull-database, without a terminal", () => {
  describe("the first pull", () => {
    it("stores a new, empty database for a user with none, and downloads it", async () => {
      const root = temporaryRoot();
      const username = await registered(root, endpoint);

      const { exitCode, output } = await pullDatabase(root);

      expect(output).toContain("Pulled 1 new part");
      expect(exitCode).toBe(0);
      expect(await storedPartCount(root, username)).toBe(1);
      expect(localFiles(root, username)).toEqual(FILES);
      expect(localParts(root, username)).toEqual(await storedParts(root, username));
      expect(queryLocal(root, username, "PRAGMA user_version")).toEqual([[LATEST_VERSION]]);
      expect(queryLocal(root, username, ACCOUNTS)).toEqual([]);
    });

    it("downloads the database a user already has, every part of it", async () => {
      const root = temporaryRoot();
      const username = await registered(root, endpoint);
      await run("seed-database", ["--root", root, "--transactions", "25", "--no-brokerage"]);
      await saveElsewhere(root, username, account("Added Later"));

      const { exitCode, output } = await pullDatabase(root);

      expect(output).toContain("Pulled 2 new parts");
      expect(exitCode).toBe(0);
      expect(await storedPartCount(root, username)).toBe(2);
      expect(localParts(root, username)).toEqual(await storedParts(root, username));
      expect(queryLocal(root, username, "SELECT count(*) FROM transactions")).toEqual([[25]]);
      expect(
        queryLocal(root, username, "SELECT count(*) FROM accounts WHERE name = 'Added Later'"),
      ).toEqual([[1]]);
    });

    it("writes a file another program can check and change", async () => {
      const { root, username } = await pulled();

      expect(queryLocal(root, username, "PRAGMA integrity_check")).toEqual([["ok"]]);
      editLocal(root, username, account("Mine"));
      expect(queryLocal(root, username, ACCOUNTS)).toEqual([["Mine", "Bank"]]);
    });
  });

  describe("a later pull", () => {
    it("leaves everything as it is when nothing new is stored", async () => {
      const { root, username } = await pulled();
      editLocal(root, username, account("Mine"));
      const database = fs.readFileSync(localDatabasePath(root, username));
      const parts = localParts(root, username);

      const { exitCode, output } = await pullDatabase(root);

      expect(output).toContain("is up to date");
      expect(exitCode).toBe(0);
      expect(fs.readFileSync(localDatabasePath(root, username))).toEqual(database);
      expect(localParts(root, username)).toEqual(parts);
      expect(localFiles(root, username)).toEqual(FILES);
      expect(await storedPartCount(root, username)).toBe(1);
    });

    it("brings in what was saved elsewhere", async () => {
      const { root, username } = await pulled();
      await saveElsewhere(root, username, account("Remote"));
      await saveElsewhere(root, username, account("Remote Too", "Card"));

      const { exitCode, output } = await pullDatabase(root);

      expect(output).toContain("Pulled 2 new parts");
      expect(output).not.toContain("your changes");
      expect(exitCode).toBe(0);
      expect(queryLocal(root, username, ACCOUNTS)).toEqual([
        ["Remote", "Bank"],
        ["Remote Too", "Card"],
      ]);
      expect(localParts(root, username)).toEqual(await storedParts(root, username));
      expect(localFiles(root, username)).toEqual(FILES);
    });

    it("moves what was changed here onto what was saved elsewhere", async () => {
      const { root, username } = await pulled();
      editLocal(root, username, account("Local"));
      await saveElsewhere(root, username, account("Remote"));

      const { exitCode, output } = await pullDatabase(root);

      expect(output).toContain("Pulled 1 new part");
      expect(output).toContain("with your changes on top");
      expect(exitCode).toBe(0);
      expect(queryLocal(root, username, ACCOUNTS)).toEqual([
        ["Local", "Bank"],
        ["Remote", "Bank"],
      ]);
      expect(localFiles(root, username)).toEqual(FILES);
      // Pulling uploads nothing: the change here is still only here.
      expect(await queryStored(root, username, ACCOUNTS)).toEqual([["Remote", "Bank"]]);
    });

    it("keeps changes here across pull after pull", async () => {
      const { root, username } = await pulled();
      editLocal(root, username, account("Local"));
      await saveElsewhere(root, username, account("First"));
      await pullDatabase(root);
      editLocal(root, username, "UPDATE accounts SET type = 'Card' WHERE name = 'First'");
      await saveElsewhere(root, username, account("Second"));

      const { exitCode } = await pullDatabase(root);

      expect(exitCode).toBe(0);
      expect(queryLocal(root, username, ACCOUNTS)).toEqual([
        ["First", "Card"],
        ["Local", "Bank"],
        ["Second", "Bank"],
      ]);
      expect(localFiles(root, username)).toEqual(FILES);
    });

    it("takes a change made the same way here and elsewhere as made", async () => {
      const { root, username } = await pulled();
      editLocal(root, username, account("Both"));
      await saveElsewhere(root, username, account("Both"));

      const { exitCode } = await pullDatabase(root);

      expect(exitCode).toBe(0);
      expect(queryLocal(root, username, ACCOUNTS)).toEqual([["Both", "Bank"]]);
      expect(localFiles(root, username)).toEqual(FILES);
    });

    it("moves over changes to a file another program left in WAL mode", async () => {
      const { root, username } = await pulled();
      editLocal(root, username, `PRAGMA journal_mode = WAL; ${account("Local")}`);
      expect(queryLocal(root, username, "PRAGMA journal_mode")).toEqual([["wal"]]);
      await saveElsewhere(root, username, account("Remote"));

      const { exitCode } = await pullDatabase(root);

      expect(exitCode).toBe(0);
      expect(queryLocal(root, username, ACCOUNTS)).toEqual([
        ["Local", "Bank"],
        ["Remote", "Bank"],
      ]);
      expect(localFiles(root, username)).toEqual(FILES);
    });

    it("writes the database again when it's gone", async () => {
      const { root, username } = await pulled();
      await saveElsewhere(root, username, account("Remote"));
      fs.rmSync(localDatabasePath(root, username));

      const { exitCode } = await pullDatabase(root);

      expect(exitCode).toBe(0);
      expect(queryLocal(root, username, ACCOUNTS)).toEqual([["Remote", "Bank"]]);
      expect(localFiles(root, username)).toEqual(FILES);
    });

    it("writes the database again when it's gone and nothing new is stored", async () => {
      const { root, username } = await pulled();
      fs.rmSync(localDatabasePath(root, username));

      const { exitCode } = await pullDatabase(root);

      expect(exitCode).toBe(0);
      expect(queryLocal(root, username, ACCOUNTS)).toEqual([]);
      expect(localFiles(root, username)).toEqual(FILES);
    });

    it("finds the newer parts' changes already made, after a pull that only got to write the database", async () => {
      const { root, username } = await pulled();
      const olderParts = localParts(root, username);
      editLocal(root, username, account("Local"));
      await saveElsewhere(root, username, account("Remote"));
      await pullDatabase(root);
      // As if that pull had stopped between writing the two files.
      fs.writeFileSync(localPartsPath(root, username), olderParts);

      const { exitCode } = await pullDatabase(root);

      expect(exitCode).toBe(0);
      expect(queryLocal(root, username, ACCOUNTS)).toEqual([
        ["Local", "Bank"],
        ["Remote", "Bank"],
      ]);
      expect(localParts(root, username)).toEqual(await storedParts(root, username));
      expect(localFiles(root, username)).toEqual(FILES);
    });
  });

  describe("a database here that can't be moved over", () => {
    const SHELVED = [".env", "database-parts", "database.old.1.sqlite3", "database.sqlite3"];

    it("is kept under another name when its changes don't fit what was saved elsewhere", async () => {
      const { root, username } = await pulled();
      await saveElsewhere(root, username, account("Shared"));
      await pullDatabase(root);
      editLocal(root, username, "UPDATE accounts SET type = 'Card' WHERE name = 'Shared'");
      await saveElsewhere(
        root,
        username,
        "UPDATE accounts SET type = 'Cash' WHERE name = 'Shared'",
      );

      const { exitCode, output } = await pullDatabase(root);

      expect(output).toContain("database.old.1.sqlite3");
      expect(output).toContain("don't fit");
      expect(exitCode).toBe(0);
      expect(localFiles(root, username)).toEqual(SHELVED);
      expect(queryLocal(root, username, ACCOUNTS)).toEqual([["Shared", "Cash"]]);
      expect(queryLocal(root, username, ACCOUNTS, "database.old.1.sqlite3")).toEqual([
        ["Shared", "Card"],
      ]);
      expect(localParts(root, username)).toEqual(await storedParts(root, username));
    });

    it("is kept under the next name there isn't yet", async () => {
      const { root, username } = await pulled();
      await saveElsewhere(root, username, account("Shared"));
      await pullDatabase(root);
      for (const type of ["Card", "Cash"]) {
        editLocal(
          root,
          username,
          `UPDATE accounts SET type = 'Mine ${type}' WHERE name = 'Shared'`,
        );
        await saveElsewhere(
          root,
          username,
          `UPDATE accounts SET type = '${type}' WHERE name = 'Shared'`,
        );
        await pullDatabase(root);
      }

      expect(localFiles(root, username)).toEqual([
        ".env",
        "database-parts",
        "database.old.1.sqlite3",
        "database.old.2.sqlite3",
        "database.sqlite3",
      ]);
      expect(queryLocal(root, username, ACCOUNTS, "database.old.1.sqlite3")).toEqual([
        ["Shared", "Mine Card"],
      ]);
      expect(queryLocal(root, username, ACCOUNTS, "database.old.2.sqlite3")).toEqual([
        ["Shared", "Mine Cash"],
      ]);
      expect(queryLocal(root, username, ACCOUNTS)).toEqual([["Shared", "Cash"]]);
    });

    it("is kept under another name when the stored database was replaced by another", async () => {
      const { root, username } = await pulled();
      editLocal(root, username, account("Local"));
      await run("seed-database", [
        ...["--root", root, "--transactions", "5", "--no-brokerage", "--replace"],
      ]);

      const { exitCode, output } = await pullDatabase(root);

      expect(output).toContain("database.old.1.sqlite3");
      expect(output).toContain("replaced");
      expect(exitCode).toBe(0);
      expect(localFiles(root, username)).toEqual(SHELVED);
      expect(queryLocal(root, username, "SELECT count(*) FROM transactions")).toEqual([[5]]);
      expect(queryLocal(root, username, ACCOUNTS, "database.old.1.sqlite3")).toEqual([
        ["Local", "Bank"],
      ]);
      expect(localParts(root, username)).toEqual(await storedParts(root, username));
    });

    it("is kept under another name when the stored database was replaced, even unchanged", async () => {
      const { root, username } = await pulled();
      await run("seed-database", [
        ...["--root", root, "--transactions", "5", "--no-brokerage", "--replace"],
      ]);

      const { exitCode } = await pullDatabase(root);

      expect(exitCode).toBe(0);
      // It may be the only copy left of what was stored before.
      expect(localFiles(root, username)).toEqual(SHELVED);
    });

    it("is kept under another name when the parts it was made from are gone", async () => {
      const { root, username } = await pulled();
      editLocal(root, username, account("Local"));
      fs.rmSync(localPartsPath(root, username));

      const { exitCode, output } = await pullDatabase(root);

      expect(output).toContain("database.old.1.sqlite3");
      expect(exitCode).toBe(0);
      expect(localFiles(root, username)).toEqual(SHELVED);
      expect(queryLocal(root, username, ACCOUNTS)).toEqual([]);
      expect(queryLocal(root, username, ACCOUNTS, "database.old.1.sqlite3")).toEqual([
        ["Local", "Bank"],
      ]);
    });

    it("is kept under another name when the parts it was made from aren't parts", async () => {
      const { root, username } = await pulled();
      editLocal(root, username, account("Local"));
      fs.writeFileSync(localPartsPath(root, username), "not parts");

      const { exitCode } = await pullDatabase(root);

      expect(exitCode).toBe(0);
      expect(localFiles(root, username)).toEqual(SHELVED);
      expect(localParts(root, username)).toEqual(await storedParts(root, username));
    });

    it("is kept under another name when its tables were changed", async () => {
      const { root, username } = await pulled();
      editLocal(root, username, `CREATE TABLE notes (text TEXT); ${account("Local")}`);
      await saveElsewhere(root, username, account("Remote"));

      const { exitCode, output } = await pullDatabase(root);

      expect(output).toContain("database.old.1.sqlite3");
      expect(output).toContain("tables");
      expect(exitCode).toBe(0);
      expect(localFiles(root, username)).toEqual(SHELVED);
      expect(queryLocal(root, username, ACCOUNTS)).toEqual([["Remote", "Bank"]]);
    });

    it("is kept under another name when it isn't a database", async () => {
      const { root, username } = await pulled();
      fs.writeFileSync(localDatabasePath(root, username), "not a database, but somebody's notes");
      await saveElsewhere(root, username, account("Remote"));

      const { exitCode, output } = await pullDatabase(root);

      expect(output).toContain("database.old.1.sqlite3");
      expect(exitCode).toBe(0);
      expect(localFiles(root, username)).toEqual(SHELVED);
      expect(
        fs.readFileSync(path.join(userDirectory(root, username), "database.old.1.sqlite3"), "utf8"),
      ).toBe("not a database, but somebody's notes");
      expect(queryLocal(root, username, ACCOUNTS)).toEqual([["Remote", "Bank"]]);
    });
  });

  describe("failing, with nothing here touched", () => {
    /** The user's directory: each file's name and bytes. */
    function snapshot(root: string, username: string) {
      return localFiles(root, username).map((name) => [
        name,
        fs.readFileSync(path.join(userDirectory(root, username), name)).toString("hex"),
      ]);
    }

    it("when another program still holds changes in a -wal file", async () => {
      const { root, username } = await pulled();
      editLocal(root, username, account("Local"));
      await saveElsewhere(root, username, account("Remote"));
      fs.writeFileSync(`${localDatabasePath(root, username)}-wal`, "changes not in the file yet");
      const before = snapshot(root, username);

      const { exitCode, output } = await pullDatabase(root);

      expect(output).toContain("database.sqlite3-wal");
      expect(exitCode).toBe(1);
      expect(snapshot(root, username)).toEqual(before);
    });

    it("when the stored database was encrypted under another key", async () => {
      const { root, username } = await pulled();
      editLocal(root, username, account("Local"));
      await saveElsewhere(root, username, account("Remote"));
      const envPath = path.join(userDirectory(root, username), ".env");
      const otherKek = Buffer.alloc(32, 7).toString("base64url");
      fs.writeFileSync(
        envPath,
        fs.readFileSync(envPath, "utf8").replace(sessionEnv(root, username).SPENDY2_KEK!, otherKek),
      );
      const before = snapshot(root, username);

      const { exitCode, output } = await pullDatabase(root);

      expect(output).toContain("can't be read");
      expect(exitCode).toBe(1);
      expect(snapshot(root, username)).toEqual(before);
    });

    it("when the session has ended", async () => {
      const { root, username } = await pulled();
      await saveElsewhere(root, username, account("Remote"));
      const envPath = path.join(userDirectory(root, username), ".env");
      fs.writeFileSync(
        envPath,
        fs
          .readFileSync(envPath, "utf8")
          .replace(sessionEnv(root, username).SPENDY2_TOKEN!, "ended"),
      );
      const before = snapshot(root, username);

      const { exitCode, output } = await pullDatabase(root);

      expect(output).toContain("The session has ended");
      expect(exitCode).toBe(1);
      expect(snapshot(root, username)).toEqual(before);
    });

    it("when the server can't be reached", async () => {
      const { root, username } = await pulled();
      const envPath = path.join(userDirectory(root, username), ".env");
      fs.writeFileSync(
        envPath,
        // Port 9 (discard): nothing listens there.
        fs.readFileSync(envPath, "utf8").replace(endpoint, "http://127.0.0.1:9/"),
      );
      const before = snapshot(root, username);

      const { exitCode, output } = await pullDatabase(root);

      expect(output).toContain("Could not reach");
      expect(exitCode).toBe(1);
      expect(snapshot(root, username)).toEqual(before);
    });

    it("when there's more than one user and no --user", async () => {
      const { root, username } = await pulled();
      const other = await registered(root, endpoint);
      const before = snapshot(root, username);

      const { exitCode, output } = await pullDatabase(root);

      expect(output).toContain("--user is required");
      expect(exitCode).toBe(1);
      expect(snapshot(root, username)).toEqual(before);
      expect(localFiles(root, other)).toEqual([".env"]);
    });
  });

  it("pulls only --user's database when there's more than one user", async () => {
    const { root, username } = await pulled();
    const other = await registered(root, endpoint);

    const { exitCode } = await pullDatabase(root, "--user", other);

    expect(exitCode).toBe(0);
    expect(localFiles(root, other)).toEqual(FILES);
    expect(await storedPartCount(root, username)).toBe(1);
  });
});
