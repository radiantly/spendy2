import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "./database.ts";
import { EditHistory, type Step } from "./editHistory.ts";
import { ClosedError } from "./rpc.ts";

/** The part of a Database the history uses. */
let database: { undo: ReturnType<typeof vi.fn>; redo: ReturnType<typeof vi.fn> };
let history: EditHistory<string>;

/** The changes a step named `about` made. */
const changesOf = (about: string) => new Uint8Array([about.charCodeAt(0)]);
const step = (about: string): Step<string> => ({
  changes: Promise.resolve(changesOf(about)),
  about,
});
const [a, b, c] = [step("a"), step("b"), step("c")];

/** A step for an edit still being written: `write` or `fail` finishes it. */
function writing(about: string) {
  let write!: () => void;
  let fail!: () => void;
  const changes = new Promise<Uint8Array>((resolve, reject) => {
    write = () => resolve(changesOf(about));
    fail = () => reject(new Error("Couldn't write it"));
  });
  return { step: { changes, about } satisfies Step<string>, write, fail };
}

beforeEach(() => {
  database = { undo: vi.fn(async () => {}), redo: vi.fn(async () => {}) };
  history = new EditHistory(database as unknown as Database);
});

const undoneSteps = () => database.undo.mock.calls.map(([changes]) => changes);
const redoneSteps = () => database.redo.mock.calls.map(([changes]) => changes);

describe("EditHistory", () => {
  it("has nothing to undo or redo at first", async () => {
    expect(await history.undo()).toBeNull();
    expect(await history.redo()).toBeNull();
    expect(database.undo).not.toHaveBeenCalled();
    expect(history.latest).toBeNull();
  });

  it("undoes the latest edit first, in the database", async () => {
    history.record(a);
    history.record(b);

    expect(await history.undo()).toEqual({ direction: "undo", step: b });
    expect(await history.undo()).toEqual({ direction: "undo", step: a });
    expect(await history.undo()).toBeNull();
    expect(undoneSteps()).toEqual([changesOf("b"), changesOf("a")]);
  });

  it("redoes what was undone, latest undone first", async () => {
    history.record(a);
    history.record(b);
    await history.undo();
    await history.undo();

    expect(await history.redo()).toEqual({ direction: "redo", step: a });
    expect(await history.redo()).toEqual({ direction: "redo", step: b });
    expect(await history.redo()).toBeNull();
    expect(redoneSteps()).toEqual([changesOf("a"), changesOf("b")]);
  });

  it("forgets what could be redone on a new edit", async () => {
    history.record(a);
    await history.undo();

    history.record(c);

    expect(await history.redo()).toBeNull();
    expect((await history.undo())?.step).toBe(c);
  });

  it("takes steps straight away, so undoing twice at once undoes two edits", async () => {
    history.record(a);
    history.record(b);

    const moves = await Promise.all([history.undo(), history.undo()]);

    expect(moves.map((moved) => moved?.step)).toEqual([b, a]);
  });

  it("undoes an edit still being written once it's written, not the one before", async () => {
    history.record(a);
    const b = writing("b");
    history.record(b.step);

    const undone = history.undo();
    await Promise.resolve();
    expect(database.undo).not.toHaveBeenCalled();
    b.write();

    expect(await undone).toEqual({ direction: "undo", step: b.step });
    expect(undoneSteps()).toEqual([changesOf("b")]);
  });

  it("undoes in order when the latest edit is still being written", async () => {
    history.record(a);
    const b = writing("b");
    history.record(b.step);

    const undone = Promise.all([history.undo(), history.undo()]);
    b.write();
    await undone;

    expect(undoneSteps()).toEqual([changesOf("b"), changesOf("a")]);
  });

  it("forgets an edit that couldn't be written, undoing nothing for it", async () => {
    history.record(a);
    const b = writing("b");
    history.record(b.step);

    const undone = history.undo();
    b.fail();

    expect(await undone).toBeNull();
    expect(await history.redo()).toBeNull();
    expect((await history.undo())?.step).toBe(a);
    expect(undoneSteps()).toEqual([changesOf("a")]);
  });

  it("forgets an edit that couldn't be written before it was undone", async () => {
    history.record(a);
    const b = writing("b");
    history.record(b.step);
    b.fail();
    await b.step.changes.catch(() => {});

    expect((await history.undo())?.step).toBe(a);
  });

  it("tells listeners after each undo or redo, with the latest", async () => {
    const listener = vi.fn(() => history.latest);
    history.subscribe(listener);
    history.record(a);

    const undone = await history.undo();
    const redone = await history.redo();

    expect(listener.mock.results.map(({ value }) => value)).toEqual([undone, redone]);
    expect(history.latest).toBe(redone);
    // A new object each time, even for the same step.
    expect(undone).not.toBe(redone);
  });

  it("stops telling a listener once unsubscribed", async () => {
    const listener = vi.fn();
    history.subscribe(listener)();
    history.record(a);

    await history.undo();

    expect(listener).not.toHaveBeenCalled();
  });

  it("forgets everything when an undo fails, and says why", async () => {
    const error = new Error("The changes don't match the database");
    database.undo.mockRejectedValueOnce(error);
    history.record(a);
    history.record(b);

    expect(await history.undo()).toEqual({ direction: "undo", step: b, error });
    expect(await history.undo()).toBeNull();
    expect(await history.redo()).toBeNull();
  });

  it("rejects without telling anyone when the database has closed", async () => {
    const listener = vi.fn();
    history.subscribe(listener);
    database.undo.mockRejectedValueOnce(new ClosedError());
    history.record(a);

    await expect(history.undo()).rejects.toBeInstanceOf(ClosedError);
    expect(listener).not.toHaveBeenCalled();
  });
});
