/**
 * Replaces the logged-in user's database with generated test data, for
 * trying out the app with a realistic amount of it. Uses the session from
 * `npm run init-session`.
 */
import fs from "fs";
import path from "path";
import { confirm, intro, isCancel, outro, spinner, text } from "@clack/prompts";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { encryptDatabase } from "../src/db/blob.ts";
import { migrate, migrationsFromFiles } from "../src/db/migrate.ts";
import { deriveKek } from "../src/lib/kek.ts";
import { fail, onCancel, readEnv } from "./lib.ts";
import { generateTestData } from "./testData.ts";

const scriptsEnvPath = path.join(import.meta.dirname, ".env");
const migrationsDir = path.join(import.meta.dirname, "..", "src", "db", "migrations");

async function request(endpoint: string, token: string, init: RequestInit = {}) {
  const target = new URL("/api/users/me/database", endpoint);
  try {
    return await fetch(target, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...init.headers },
    });
  } catch {
    fail(`Could not reach ${target}`);
  }
}

intro("Seed database");

const env = readEnv(scriptsEnvPath);
const {
  SPENDY2_ENDPOINT: endpoint,
  SPENDY2_USERNAME: username,
  SPENDY2_TOKEN: token,
  SPENDY2_EXPORT_KEY: exportKey,
} = env;
if (!endpoint || !username || !token || !exportKey)
  fail("No session, run npm run init-session first");

const countText = await text({
  message: "How many transactions?",
  initialValue: "100000",
  validate: (value) =>
    /^[1-9]\d*$/.test(value ?? "") ? undefined : "Enter a positive whole number",
});
if (isCancel(countText)) onCancel();
const count = Number(countText);

const existing = await request(endpoint, token);
if (existing.status === 401) fail("The session has ended, run npm run init-session again");
if (existing.status !== 404 && !existing.ok)
  fail(`Couldn't check for an existing database: ${existing.status}`);
const currentEtag = existing.ok ? existing.headers.get("ETag") : null;
if (currentEtag !== null) {
  const overwrite = await confirm({
    message: `${username} already has a database. Replace it with generated data?`,
    initialValue: false,
  });
  if (isCancel(overwrite) || !overwrite) onCancel();
}

const progress = spinner();
progress.start(`Generating ${count.toLocaleString("en-US")} transactions`);

const sqlite3 = await sqlite3InitModule();
const db = new sqlite3.oo1.DB(":memory:");
const migrations = migrationsFromFiles(
  Object.fromEntries(
    fs
      .readdirSync(migrationsDir)
      .map((file) => [file, fs.readFileSync(path.join(migrationsDir, file), "utf8")]),
  ),
);
migrate(db, migrations);
db.exec("PRAGMA foreign_keys = ON");
generateTestData(db, count);
const bytes = sqlite3.capi.sqlite3_js_db_export(db);
db.close();

progress.message("Encrypting");
const blob = await encryptDatabase(bytes, await deriveKek(exportKey));

progress.message(`Uploading ${(blob.length / 1e6).toFixed(1)} MB`);
const upload = await request(endpoint, token, {
  method: "PUT",
  headers: currentEtag === null ? { "If-None-Match": "*" } : { "If-Match": currentEtag },
  body: blob,
});
if (!upload.ok) {
  progress.stop("Upload failed");
  fail(`Upload failed: ${upload.status} ${await upload.text()}`);
}

progress.stop("Uploaded");
outro(`Seeded ${username}'s database with ${count.toLocaleString("en-US")} transactions`);
