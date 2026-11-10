/**
 * Runs the scripts as an AI agent or another script would: as a process of
 * their own with no terminal, so whatever they'd ask has to come as a flag.
 */
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { inject } from "vitest";
import { parseEnv } from "util";

export type Script = "init-session" | "pull-database" | "seed-database";

export type Run = { exitCode: number | null; output: string };

/** Runs a script with `args`, giving what it printed, to either stream. */
export function run(script: Script, args: readonly string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(import.meta.dirname, "..", `${script}.ts`), ...args],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, output }));
  });
}

/** A new, empty directory to pass as `--root`; the global setup removes it after the run. */
export function temporaryRoot(): string {
  return fs.mkdtempSync(path.join(inject("temporaryDirectory"), "root-"));
}

/** A username no other test has used: the worker keeps its users for the whole run. */
export function newUsername(): string {
  return `u${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

export const PASSWORD = "correct horse battery staple";

export function userDirectory(root: string, username: string): string {
  return path.join(root, `User Data (${username})`);
}

/** What the .env in the user's directory holds. */
export function sessionEnv(root: string, username: string) {
  return parseEnv(fs.readFileSync(path.join(userDirectory(root, username), ".env"), "utf8"));
}

/** Registers a new user with `init-session`, giving their name. */
export async function registered(root: string, endpoint: string): Promise<string> {
  const username = newUsername();
  const { exitCode, output } = await run("init-session", [
    ...["--root", root, "--endpoint", endpoint],
    ...["--username", username, "--password", PASSWORD, "--register"],
  ]);
  if (exitCode !== 0) throw new Error(`Couldn't register ${username}: ${output}`);
  return username;
}
