/**
 * Undo and redo for edits to the database: a stack of steps to undo, and
 * one of steps undone that can be redone. Making a new edit forgets what
 * could be redone. Lasts as long as the open database it's for.
 */
import type { Database } from "./database.ts";
import { ClosedError } from "./rpc.ts";

/**
 * One edit: the changes it made, as `Database.batch` resolves with them
 * (recorded before they're written), and `about`, what the page that made
 * it needs to show where an undo or redo of it happens.
 */
export type Step<T> = { changes: Promise<Uint8Array>; about: T };

type Stacks<T> = { undo: readonly Step<T>[]; redo: readonly Step<T>[] };

/** An undo or redo that ran; `error` if it couldn't be done. */
export type Moved<T> = { direction: "undo" | "redo"; step: Step<T>; error?: unknown };

export class EditHistory<T> {
  readonly #database: Database;
  #stacks: Stacks<T> = { undo: [], redo: [] };
  #latest: Moved<T> | null = null;
  /** Settles when the latest undo or redo has; they run one at a time, in order. */
  #moving: Promise<unknown> = Promise.resolve();
  readonly #listeners = new Set<() => void>();

  constructor(database: Database) {
    this.#database = database;
  }

  /**
   * Adds an edit, made last, to undo. Recorded as soon as it's asked for, so
   * an undo pressed while it's being written undoes it, once it's written.
   * If it can't be written, it was never made, and is forgotten.
   */
  record(step: Step<T>) {
    this.#stacks = { undo: [...this.#stacks.undo, step], redo: [] };
    step.changes.catch(() => {
      this.#stacks = {
        undo: this.#stacks.undo.filter((recorded) => recorded !== step),
        redo: this.#stacks.redo.filter((recorded) => recorded !== step),
      };
    });
  }

  /**
   * Undoes the latest edit not undone, in the database. Resolves once it's
   * done (or failed), with what was undone; null if there was nothing to, or
   * the edit couldn't be written.
   * Steps are taken from the history straight away, so undoing twice in a
   * row undoes two edits.
   */
  undo() {
    const step = this.#stacks.undo.at(-1);
    if (step === undefined) return Promise.resolve(null);
    this.#stacks = {
      undo: this.#stacks.undo.slice(0, -1),
      redo: [...this.#stacks.redo, step],
    };
    return this.#run("undo", step, (changes) => this.#database.undo(changes));
  }

  /** Redoes the latest edit undone, as `undo` undoes. */
  redo() {
    const step = this.#stacks.redo.at(-1);
    if (step === undefined) return Promise.resolve(null);
    this.#stacks = {
      undo: [...this.#stacks.undo, step],
      redo: this.#stacks.redo.slice(0, -1),
    };
    return this.#run("redo", step, (changes) => this.#database.redo(changes));
  }

  /**
   * The latest undo or redo that ran; null before any. A new object each
   * time, even for the same step.
   */
  get latest() {
    return this.#latest;
  }

  /**
   * Calls `listener` after each undo or redo, until the returned function is
   * called. The same function every time, as `useSyncExternalStore` wants.
   */
  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  };

  /**
   * Runs an undo or redo after the ones before it, telling the listeners.
   * If it fails, the database no longer matches the history (a bug), so the
   * history is forgotten.
   */
  #run(
    direction: Moved<T>["direction"],
    step: Step<T>,
    apply: (changes: Uint8Array) => Promise<void>,
  ) {
    const moved = this.#moving.then(() => this.#move(direction, step, apply));
    this.#moving = moved.catch(() => {});
    return moved;
  }

  async #move(
    direction: Moved<T>["direction"],
    step: Step<T>,
    apply: (changes: Uint8Array) => Promise<void>,
  ) {
    let changes: Uint8Array;
    try {
      changes = await step.changes;
    } catch {
      // Never written, so there's nothing to undo (`record` forgets it).
      return null;
    }
    let moved: Moved<T>;
    try {
      await apply(changes);
      moved = { direction, step };
    } catch (error) {
      // The database closed (e.g. on logging out): no one's left to tell.
      if (error instanceof ClosedError) throw error;
      this.#stacks = { undo: [], redo: [] };
      moved = { direction, step, error };
    }
    this.#latest = moved;
    for (const listener of this.#listeners) listener();
    return moved;
  }
}
