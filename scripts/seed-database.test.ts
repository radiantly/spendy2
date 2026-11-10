import fs from "fs";
import path from "path";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { describe, expect, inject, it } from "vitest";
import { decryptPart, readChain } from "../src/db/parts.ts";
import { importKek } from "../src/lib/kek.ts";
import { registered, run, sessionEnv, temporaryRoot, userDirectory } from "./test/run.ts";

const endpoint = inject("endpoint");

function seedDatabase(root: string, ...args: string[]) {
  return run("seed-database", ["--root", root, ...args]);
}

const SEED = ["--transactions", "40", "--no-brokerage"];

/** The user's stored database: its parts' count, its ETag, and what a query of it gives. */
async function stored(root: string, username: string, sql: string) {
  const env = sessionEnv(root, username);
  const response = await fetch(new URL("/api/users/me/database/parts", endpoint), {
    headers: { Authorization: `Bearer ${env.SPENDY2_TOKEN}` },
  });
  if (!response.ok) return { status: response.status };

  const parts = await readChain(new Uint8Array(await response.arrayBuffer()));
  const kek = await importKek(new Uint8Array(Buffer.from(env.SPENDY2_KEK!, "base64url")));
  const sqlite3 = await sqlite3InitModule();
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    const bytes = await decryptPart(parts[0]!, kek);
    const pointer = sqlite3.wasm.allocFromTypedArray(bytes);
    db.checkRc(
      sqlite3.capi.sqlite3_deserialize(
        db,
        "main",
        pointer,
        bytes.length,
        bytes.length,
        sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE,
      ),
    );
    return {
      status: response.status,
      parts: parts.length,
      etag: response.headers.get("ETag"),
      value: db.selectValue(sql),
    };
  } finally {
    db.close();
  }
}

describe("seed-database, without a terminal", () => {
  it("uploads a database of generated transactions, as the only part", async () => {
    const root = temporaryRoot();
    const username = await registered(root, endpoint);

    const { exitCode, output } = await seedDatabase(root, ...SEED);

    expect(output).toContain(`Seeded ${username}'s database with 40 transactions`);
    expect(exitCode).toBe(0);
    expect(await stored(root, username, "SELECT count(*) FROM transactions")).toMatchObject({
      parts: 1,
      value: 40,
    });
  });

  it("adds the brokerage account with --brokerage, and not with --no-brokerage", async () => {
    const root = temporaryRoot();
    const username = await registered(root, endpoint);
    const brokerageAccounts = "SELECT count(*) FROM accounts WHERE type = 'Brokerage'";

    await seedDatabase(root, "--transactions", "40", "--no-brokerage");
    const without = await stored(root, username, brokerageAccounts);
    await seedDatabase(root, "--transactions", "40", "--brokerage", "--replace");
    const withBrokerage = await stored(root, username, brokerageAccounts);

    expect(without.value).toBe(0);
    expect(withBrokerage.value).toBe(1);
  });

  it("doesn't replace a database there already is, unless told to", async () => {
    const root = temporaryRoot();
    const username = await registered(root, endpoint);
    await seedDatabase(root, ...SEED);
    const before = await stored(root, username, "SELECT 1");

    const { exitCode, output } = await seedDatabase(root, ...SEED);

    expect(output).toContain("--replace");
    expect(exitCode).toBe(1);
    expect((await stored(root, username, "SELECT 1")).etag).toBe(before.etag);
  });

  it("replaces a database there already is with --replace", async () => {
    const root = temporaryRoot();
    const username = await registered(root, endpoint);
    await seedDatabase(root, ...SEED);
    const before = await stored(root, username, "SELECT 1");

    const { exitCode } = await seedDatabase(
      root,
      "--transactions",
      "7",
      "--no-brokerage",
      "--replace",
    );

    expect(exitCode).toBe(0);
    const after = await stored(root, username, "SELECT count(*) FROM transactions");
    expect(after).toMatchObject({ parts: 1, value: 7 });
    expect(after.etag).not.toBe(before.etag);
  });

  it("takes --replace when there's no database to replace", async () => {
    const root = temporaryRoot();
    const username = await registered(root, endpoint);

    const { exitCode } = await seedDatabase(root, ...SEED, "--replace");

    expect(exitCode).toBe(0);
    expect(await stored(root, username, "SELECT 1")).toMatchObject({ parts: 1 });
  });

  it.for([
    ["--transactions", ["--no-brokerage"]],
    ["--brokerage", ["--transactions", "40"]],
  ] as const)("fails naming %s when it isn't given", async ([missing, given]) => {
    const root = temporaryRoot();
    const username = await registered(root, endpoint);

    const { exitCode, output } = await seedDatabase(root, ...given);

    expect(output).toContain(missing);
    expect(output).toContain("is required");
    expect(exitCode).toBe(1);
    expect(await stored(root, username, "SELECT 1")).toEqual({ status: 404 });
  });

  it.for(["0", "-5", "1.5", "many"])("fails on --transactions %s", async (count) => {
    const root = temporaryRoot();
    await registered(root, endpoint);

    const { exitCode, output } = await seedDatabase(
      root,
      `--transactions=${count}`,
      "--no-brokerage",
    );

    expect(output).toContain("--transactions: ");
    expect(exitCode).toBe(1);
  });

  describe("choosing the user", () => {
    it("fails, pointing at init-session, when there's no user", async () => {
      const root = temporaryRoot();

      const { exitCode, output } = await seedDatabase(root, ...SEED);

      expect(output).toContain("npm run init-session");
      expect(exitCode).toBe(1);
    });

    it("fails naming --user, and the users, when there's more than one", async () => {
      const root = temporaryRoot();
      const first = await registered(root, endpoint);
      const second = await registered(root, endpoint);

      const { exitCode, output } = await seedDatabase(root, ...SEED);

      expect(output).toContain("--user is required");
      expect(output).toContain(first);
      expect(output).toContain(second);
      expect(exitCode).toBe(1);
      expect(await stored(root, first, "SELECT 1")).toEqual({ status: 404 });
      expect(await stored(root, second, "SELECT 1")).toEqual({ status: 404 });
    });

    it("seeds only --user's database when there's more than one", async () => {
      const root = temporaryRoot();
      const first = await registered(root, endpoint);
      const second = await registered(root, endpoint);

      const { exitCode } = await seedDatabase(root, ...SEED, "--user", second);

      expect(exitCode).toBe(0);
      expect(await stored(root, first, "SELECT 1")).toEqual({ status: 404 });
      expect(await stored(root, second, "SELECT 1")).toMatchObject({ parts: 1 });
    });

    it("fails on a --user there's no directory of, even with a single other user", async () => {
      const root = temporaryRoot();
      const username = await registered(root, endpoint);

      const { exitCode, output } = await seedDatabase(root, ...SEED, "--user", "nobody");

      expect(output).toContain("--user: nobody is not one of");
      expect(exitCode).toBe(1);
      expect(await stored(root, username, "SELECT 1")).toEqual({ status: 404 });
    });

    it("ignores directories that aren't a user's", async () => {
      const root = temporaryRoot();
      const username = await registered(root, endpoint);
      fs.mkdirSync(path.join(root, "User Data"));
      fs.mkdirSync(path.join(root, "node_modules"));
      fs.writeFileSync(path.join(root, "User Data (file)"), "");

      const { exitCode } = await seedDatabase(root, ...SEED);

      expect(exitCode).toBe(0);
      expect(await stored(root, username, "SELECT 1")).toMatchObject({ parts: 1 });
    });
  });

  describe("the session", () => {
    it("fails, pointing at init-session, when the directory has no .env", async () => {
      const root = temporaryRoot();
      const username = await registered(root, endpoint);
      fs.rmSync(path.join(userDirectory(root, username), ".env"));

      const { exitCode, output } = await seedDatabase(root, ...SEED);

      expect(output).toContain(`No session for ${username}`);
      expect(output).toContain("npm run init-session");
      expect(exitCode).toBe(1);
    });

    it("fails when the .env is another user's", async () => {
      const root = temporaryRoot();
      const first = await registered(root, endpoint);
      const second = await registered(root, endpoint);
      fs.copyFileSync(
        path.join(userDirectory(root, first), ".env"),
        path.join(userDirectory(root, second), ".env"),
      );

      const { exitCode, output } = await seedDatabase(root, ...SEED, "--user", second);

      expect(output).toContain(`No session for ${second}`);
      expect(exitCode).toBe(1);
      expect(await stored(root, first, "SELECT 1")).toEqual({ status: 404 });
    });

    it("fails, pointing at init-session, when the session has ended", async () => {
      const root = temporaryRoot();
      const username = await registered(root, endpoint);
      const envPath = path.join(userDirectory(root, username), ".env");
      const env = sessionEnv(root, username);
      fs.writeFileSync(
        envPath,
        fs.readFileSync(envPath, "utf8").replace(env.SPENDY2_TOKEN!, "ended"),
      );

      const { exitCode, output } = await seedDatabase(root, ...SEED);

      expect(output).toContain("The session has ended");
      expect(exitCode).toBe(1);
    });
  });
});
