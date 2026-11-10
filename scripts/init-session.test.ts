import fs from "fs";
import path from "path";
import { describe, expect, inject, it } from "vitest";
import {
  PASSWORD,
  newUsername,
  registered,
  run,
  sessionEnv,
  temporaryRoot,
  userDirectory,
} from "./test/run.ts";

const endpoint = inject("endpoint");

function initSession(root: string, flags: Record<string, string>, ...more: string[]) {
  return run("init-session", [
    ...["--root", root],
    ...Object.entries(flags).flatMap(([flag, value]) => [`--${flag}`, value]),
    ...more,
  ]);
}

describe("init-session, without a terminal", () => {
  it("registers a user with --register, and keeps the session in their directory", async () => {
    const root = temporaryRoot();
    const username = newUsername();

    const { exitCode, output } = await initSession(
      root,
      { endpoint, username, password: PASSWORD },
      "--register",
    );

    expect(output).toContain(`Logged in as ${username}`);
    expect(exitCode).toBe(0);
    expect(fs.readdirSync(root)).toEqual([`User Data (${username})`]);
    expect(sessionEnv(root, username)).toEqual({
      SPENDY2_ENDPOINT: endpoint,
      SPENDY2_USERNAME: username,
      SPENDY2_TOKEN: expect.stringMatching(/./),
      // 32 bytes, as unpadded base64url.
      SPENDY2_KEK: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    });
  });

  it("keeps a session the API accepts", async () => {
    const root = temporaryRoot();
    const username = await registered(root, endpoint);

    const response = await fetch(new URL("/api/users/me/database/parts", endpoint), {
      headers: { Authorization: `Bearer ${sessionEnv(root, username).SPENDY2_TOKEN}` },
    });

    // Not a 401: the user is known, and has no database yet.
    expect(response.status).toBe(404);
  });

  it("logs in a user there already is, giving the same KEK", async () => {
    const root = temporaryRoot();
    const username = await registered(root, endpoint);
    const first = sessionEnv(root, username);

    const { exitCode } = await initSession(root, { endpoint, username, password: PASSWORD });

    expect(exitCode).toBe(0);
    const second = sessionEnv(root, username);
    expect(second.SPENDY2_KEK).toBe(first.SPENDY2_KEK);
    expect(second.SPENDY2_TOKEN).not.toBe(first.SPENDY2_TOKEN);
  });

  it("leaves what else the user's directory holds", async () => {
    const root = temporaryRoot();
    const username = await registered(root, endpoint);
    const database = path.join(userDirectory(root, username), "database.sqlite3");
    fs.writeFileSync(database, "kept");

    await initSession(root, { endpoint, username, password: PASSWORD });

    expect(fs.readFileSync(database, "utf8")).toBe("kept");
  });

  it("doesn't register a user unless told to", async () => {
    const root = temporaryRoot();
    const username = newUsername();

    const { exitCode, output } = await initSession(root, {
      endpoint,
      username,
      password: PASSWORD,
    });

    expect(output).toContain("--register");
    expect(exitCode).toBe(1);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("fails on a wrong password, even with --register, and keeps the session there was", async () => {
    const root = temporaryRoot();
    const username = await registered(root, endpoint);
    const before = sessionEnv(root, username);

    const { exitCode, output } = await initSession(
      root,
      { endpoint, username, password: "not the password" },
      "--register",
    );

    expect(output).toContain("already exists");
    expect(exitCode).toBe(1);
    expect(sessionEnv(root, username)).toEqual(before);
  });

  it.for(["endpoint", "username", "password"])(
    "fails naming --%s when it isn't given",
    async (missing) => {
      const root = temporaryRoot();
      const flags: Record<string, string> = {
        endpoint,
        username: newUsername(),
        password: PASSWORD,
      };
      delete flags[missing];

      const { exitCode, output } = await initSession(root, flags, "--register");

      expect(output).toContain(`--${missing} is required`);
      expect(exitCode).toBe(1);
      expect(fs.readdirSync(root)).toEqual([]);
    },
  );

  it.for([
    ["endpoint", "not a url"],
    ["username", "Not Allowed"],
    ["password", ""],
  ] as const)("fails on a --%s that isn't one", async ([flag, value]) => {
    const root = temporaryRoot();

    const { exitCode, output } = await initSession(
      root,
      { endpoint, username: newUsername(), password: PASSWORD, [flag]: value },
      "--register",
    );

    expect(output).toContain(`--${flag}: `);
    expect(exitCode).toBe(1);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("fails on a flag it doesn't know", async () => {
    const root = temporaryRoot();

    const { exitCode, output } = await initSession(
      root,
      { endpoint, username: newUsername(), password: PASSWORD, user: "alice" },
      "--register",
    );

    expect(output).toContain("--user");
    expect(exitCode).toBe(1);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("fails when the endpoint can't be reached", async () => {
    const root = temporaryRoot();

    const { exitCode, output } = await initSession(
      root,
      // Port 9 (discard): nothing listens there.
      { endpoint: "http://127.0.0.1:9", username: newUsername(), password: PASSWORD },
      "--register",
    );

    expect(output).toContain("Could not reach http://127.0.0.1:9/");
    expect(exitCode).toBe(1);
  });
});
