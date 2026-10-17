import { vi } from "vitest";
import { Database } from "../db/database.ts";

/**
 * Holds back the next call to the database's `method` whose arguments
 * match, until it's released (and then run) or failed (and never run).
 * `release` resolves once it has run.
 */
export function holdNext<M extends "query" | "batch">(
  method: M,
  match: (...args: Parameters<Database[M]>) => boolean,
) {
  type Call = (this: Database, ...args: Parameters<Database[M]>) => Promise<unknown>;
  const original = Database.prototype[method] as Call;
  let settle!: (outcome: "release" | "fail") => void;
  const held = new Promise<"release" | "fail">((resolve) => (settle = resolve));
  let written: Promise<unknown> | undefined;
  const spy = vi.spyOn(Database.prototype, method as "query").mockImplementation(function (
    this: Database,
    ...args
  ) {
    const call = args as Parameters<Database[M]>;
    if (!match(...call)) return original.apply(this, call) as ReturnType<Database["query"]>;
    spy.mockRestore();
    const result = held.then((outcome) => {
      if (outcome === "fail") throw new Error("disk on fire");
      return original.apply(this, call);
    });
    written = result;
    return result as ReturnType<Database["query"]>;
  });
  return {
    release: () => {
      settle("release");
      return written;
    },
    fail: () => settle("fail"),
  };
}
