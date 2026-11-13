/**
 * What a script is told on its command line. Every question a script asks
 * has a flag that answers it, so a script can run with nobody at a terminal
 * (an AI agent, another script): it then fails naming the flag it needs,
 * rather than waiting on a prompt nobody will see.
 */
import path from "path";
import { parseArgs, type ParseArgsOptionsConfig } from "util";
import { fail, onCancel } from "./lib.ts";

/** Flags every script takes. */
const COMMON_FLAGS = {
  /** Where the `User Data (username)` directories are, instead of the repository. */
  root: { type: "string" },
} as const satisfies ParseArgsOptionsConfig;

const REPOSITORY = path.join(import.meta.dirname, "..", "..");

/**
 * The command line's flags: `flags`, and the ones every script takes. Fails
 * on anything else there, a misspelt flag included. A boolean flag can be
 * negated (`--no-brokerage`), and is undefined when not given either way.
 */
export function parseFlags<Flags extends ParseArgsOptionsConfig>(flags: Flags) {
  try {
    const { values } = parseArgs({
      options: { ...flags, ...COMMON_FLAGS },
      strict: true,
      allowPositionals: false,
      allowNegative: true,
    });
    // Read on their own, as the flags above are only known where this is called.
    const common = parseArgs({ options: COMMON_FLAGS, strict: false }).values;
    const root = typeof common.root === "string" ? common.root : REPOSITORY;
    return { ...values, root: path.resolve(root) };
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

/** Whether there's somebody to ask: both ends of the script are a terminal. */
function hasTerminal() {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/** A prompt's answer; a prompt gives a symbol only when it's cancelled (see clack's `isCancel`). */
function answered<Answer>(answer: Answer | symbol): Answer {
  return typeof answer === "symbol" ? onCancel() : answer;
}

/** What's wrong with a value, or undefined when nothing is. */
export type Validate = (value: string | undefined) => string | undefined;

/**
 * A text the script needs: `--flag`'s value if it was given, else the
 * answer to `ask`. Both are held to `validate`; hand it to the prompt too,
 * so that a wrong answer is asked for again.
 */
export async function textFlag(
  flag: string,
  value: string | undefined,
  validate: Validate,
  ask: () => Promise<string | symbol>,
): Promise<string> {
  if (value !== undefined) {
    const problem = validate(value);
    if (problem !== undefined) fail(`--${flag}: ${problem}`);
    return value;
  }
  if (!hasTerminal()) fail(`Not run in a terminal, so --${flag} is required`);
  return answered(await ask());
}

/**
 * A yes or no the script needs: `--flag` or `--no-flag` if either was given,
 * else the answer to `ask`. `unanswered` is what to fail with when neither
 * was given and there's nobody to ask; it names the flag.
 */
export async function booleanFlag(
  value: boolean | undefined,
  ask: () => Promise<boolean | symbol>,
  unanswered: string,
): Promise<boolean> {
  if (value !== undefined) return value;
  if (!hasTerminal()) fail(unanswered);
  return answered(await ask());
}

/**
 * One of `options` the script needs: `--flag`'s value if it was given and
 * is one of them, else the one picked with `ask`.
 */
export async function choiceFlag(
  flag: string,
  value: string | undefined,
  options: readonly string[],
  ask: () => Promise<string | symbol>,
): Promise<string> {
  if (value !== undefined) {
    if (!options.includes(value)) fail(`--${flag}: ${value} is not one of ${options.join(", ")}`);
    return value;
  }
  if (!hasTerminal())
    fail(`Not run in a terminal, so --${flag} is required: one of ${options.join(", ")}`);
  return answered(await ask());
}
