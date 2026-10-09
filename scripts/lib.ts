import { cancel, password } from "@clack/prompts";
import fs from "fs";
import { parseEnv } from "util";

export function readEnv(envPath: string) {
  if (!fs.existsSync(envPath)) return {};
  return parseEnv(fs.readFileSync(envPath, "utf8"));
}

export function writeEnv(envPath: string, env: Record<string, string>) {
  const content = Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  fs.writeFileSync(envPath, content);
}

export function required(value?: string) {
  if (!value) return "Required";
}

export function url(value?: string) {
  if (!value || !URL.canParse(value)) return "Must be a URL";
}

/** A password prompt where empty input keeps the current value, if any. */
export async function secret(message: string, current?: string) {
  const value = await password({
    message: current === undefined ? message : `${message} (leave empty to keep current)`,
    validate: current === undefined ? required : undefined,
  });
  return value === "" && current !== undefined ? current : value;
}

export function onCancel(): never {
  cancel("Aborted");
  process.exit(0);
}

export function fail(message: string): never {
  cancel(message);
  process.exit(1);
}
