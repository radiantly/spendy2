/**
 * Replaces a user's database with generated test data, for trying out the
 * app with a realistic amount of it. Uses the session from
 * `npm run init-session`.
 *
 *   npm run seed-database -- [--user <name>] --transactions <count> --brokerage|--no-brokerage [--replace]
 */
import { confirm, intro, outro, spinner, text } from "@clack/prompts";
import { encryptPart } from "../src/db/parts.ts";
import { create } from "../src/db/replay.ts";
import { databaseParts } from "./lib/api.ts";
import { booleanFlag, parseFlags, textFlag } from "./lib/flags.ts";
import { fail, onCancel } from "./lib/lib.ts";
import { MIGRATIONS, sqlite3 } from "./lib/sqlite.ts";
import { generateTestData } from "./lib/seedData.ts";
import { userData } from "./lib/userData.ts";
import { NO_PREVIOUS_PART } from "../workers/spendy2/databaseParts.ts";

function positiveWholeNumber(value: string | undefined) {
  if (!/^[1-9]\d*$/.test(value ?? "")) return "Enter a positive whole number";
}

const flags = parseFlags({
  user: { type: "string" },
  transactions: { type: "string" },
  brokerage: { type: "boolean" },
  /** Replaces the database the user already has; `--no-replace` never does. */
  replace: { type: "boolean" },
});

intro("Seed database");

const { session } = await userData(flags.root, flags.user);
const { username } = session;

const count = Number(
  await textFlag("transactions", flags.transactions, positiveWholeNumber, () =>
    text({
      message: "How many transactions?",
      initialValue: "100000",
      validate: positiveWholeNumber,
    }),
  ),
);

const brokerage = await booleanFlag(
  flags.brokerage,
  () =>
    confirm({
      message: "Add a brokerage account trading in USD, EUR, GBP and JPY?",
      initialValue: true,
    }),
  "Not run in a terminal, so --brokerage or --no-brokerage is required",
);

const existing = await databaseParts(session);
if (existing.status !== 404 && !existing.ok)
  fail(`Couldn't check for an existing database: ${existing.status}`);
const currentEtag = existing.ok ? existing.headers.get("ETag") : null;
if (currentEtag !== null) {
  const replace = await booleanFlag(
    flags.replace,
    () =>
      confirm({
        message: `${username} already has a database. Replace it with generated data?`,
        initialValue: true,
      }),
    `${username} already has a database. Pass --replace to replace it with generated data`,
  );
  if (!replace) onCancel();
}

const progress = spinner();
progress.start(`Generating ${count.toLocaleString("en-US")} transactions`);

const db = create(sqlite3, MIGRATIONS);
generateTestData(db, count, { brokerage });
const userVersion = Number(db.selectValue("PRAGMA user_version"));
const bytes = sqlite3.capi.sqlite3_js_db_export(db);
db.close();

progress.message("Encrypting");
// Uploaded as the only part, replacing every part there is.
const part = await encryptPart(bytes, session.kek, {
  previousHash: NO_PREVIOUS_PART,
  userVersion,
});

progress.message(`Uploading ${(part.length / 1e6).toFixed(1)} MB`);
const upload = await databaseParts(session, {
  method: "PUT",
  headers: currentEtag === null ? { "If-None-Match": "*" } : { "If-Match": currentEtag },
  body: part,
});
if (!upload.ok) {
  progress.stop("Upload failed");
  fail(`Upload failed: ${upload.status} ${await upload.text()}`);
}

progress.stop("Uploaded");
outro(`Seeded ${username}'s database with ${count.toLocaleString("en-US")} transactions`);
