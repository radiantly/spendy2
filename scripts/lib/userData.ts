/**
 * A user's data on this machine: a `User Data (username)` directory, made by
 * `npm run init-session`, which the other scripts work in. Its .env holds
 * the session, and the scripts keep the user's database next to it.
 */
import fs from "fs";
import path from "path";
import { select } from "@clack/prompts";
import { z } from "zod";
import { importKek } from "../../src/lib/kek.ts";
import { usernameSchema } from "../../workers/spendy2/schemas.ts";
import { choiceFlag } from "./flags.ts";
import { fail, readEnv, writeEnv } from "./lib.ts";

const DIRECTORY_NAME = /^User Data \(([a-z0-9]+)\)$/;

/** A login: where to, who as, and the KEK the user's database is encrypted under. */
export type Session = { endpoint: string; username: string; token: string; kek: CryptoKey };

export type UserData = { directory: string; session: Session };

/** The session as the .env holds it; the KEK's 32 bytes as unpadded base64url. */
const envSchema = z.object({
  SPENDY2_ENDPOINT: z.url(),
  SPENDY2_USERNAME: usernameSchema,
  SPENDY2_TOKEN: z.string().min(1),
  SPENDY2_KEK: z.base64url().length(43),
});

function directoryOf(root: string, username: string) {
  return path.join(root, `User Data (${username})`);
}

/**
 * Keeps a login in the user's directory under `root`, which is made if it
 * isn't there. Whatever else the directory holds is left as it is.
 */
export function saveSession(
  root: string,
  session: Omit<Session, "kek"> & { kek: Uint8Array<ArrayBuffer> },
): string {
  const directory = directoryOf(root, session.username);
  fs.mkdirSync(directory, { recursive: true });
  writeEnv(path.join(directory, ".env"), {
    SPENDY2_ENDPOINT: session.endpoint,
    SPENDY2_USERNAME: session.username,
    SPENDY2_TOKEN: session.token,
    SPENDY2_KEK: Buffer.from(session.kek).toString("base64url"),
  } satisfies z.input<typeof envSchema>);
  return directory;
}

/** The users with a directory under `root`, in order. */
function usersIn(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const username = entry.isDirectory() ? DIRECTORY_NAME.exec(entry.name)?.[1] : undefined;
      return username === undefined ? [] : [username];
    })
    .sort();
}

/**
 * The data of the user a script is to work on: `user` (the `--user` flag) if
 * given, the only user under `root` if there's one, else the one picked.
 */
export async function userData(root: string, user: string | undefined): Promise<UserData> {
  const users = usersIn(root);
  if (users.length === 0) fail(`No user in ${root}, run npm run init-session first`);

  const username =
    user === undefined && users.length === 1
      ? users[0]!
      : await choiceFlag("user", user, users, () =>
          select({
            message: "Which user?",
            options: users.map((value) => ({ value })),
          }),
        );

  const directory = directoryOf(root, username);
  const env = envSchema.safeParse(readEnv(path.join(directory, ".env")));
  // The directory's name is what the other scripts go by, so a session for
  // someone else in it is as broken as none.
  if (!env.success || env.data.SPENDY2_USERNAME !== username)
    fail(`No session for ${username} in ${directory}, run npm run init-session again`);

  return {
    directory,
    session: {
      endpoint: env.data.SPENDY2_ENDPOINT,
      username,
      token: env.data.SPENDY2_TOKEN,
      kek: await importKek(new Uint8Array(Buffer.from(env.data.SPENDY2_KEK, "base64url"))),
    },
  };
}
