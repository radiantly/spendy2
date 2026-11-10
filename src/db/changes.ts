/**
 * Recording and replaying changes to the database with SQLite's session
 * extension. A session records every row changed while it's open, including
 * changes made by triggers and foreign key actions, as a changeset: the
 * rows' values before and after. Undo applies a changeset's inverse; redo
 * applies it again.
 */
import type { Database, SqlValue, Sqlite3Static, WasmPointer } from "@sqlite.org/sqlite-wasm";

/**
 * Leaves foreign key actions (ON DELETE, ON UPDATE) untaken when applying a
 * changeset. Not among sqlite-wasm's constants; see sqlite3.h.
 */
const SQLITE_CHANGESETAPPLY_FKNOACTION = 0x0008;

const CONFLICTS: Record<number, string> = {
  1: "DATA",
  2: "NOTFOUND",
  3: "CONFLICT",
  4: "CONSTRAINT",
  5: "FOREIGN_KEY",
};

/** Changes that don't fit the database: it doesn't hold what they expect. */
export class ChangesConflictError extends Error {
  override name = "ChangesConflictError";

  /** `conflicts` as SQLite names them: DATA, NOTFOUND, CONFLICT and so on. */
  constructor(conflicts: readonly string[]) {
    super(`The changes don't match the database (${conflicts.join(", ")})`);
  }
}

/** Copies a buffer sqlite allocated out of the wasm heap, then frees it. */
function takeBuffer(
  sqlite3: Sqlite3Static,
  db: Database,
  produce: (pSize: number, pBuffer: number) => number,
) {
  const { wasm, capi } = sqlite3;
  const stack = wasm.pstack.pointer;
  try {
    const [pSize, pBuffer] = wasm.pstack.allocPtr(2);
    db.checkRc(produce(pSize!, pBuffer!));
    const size = Number(wasm.peek(pSize!, "i32"));
    const buffer = wasm.peekPtr(pBuffer!);
    try {
      return wasm.heap8u().slice(buffer, buffer + size);
    } finally {
      capi.sqlite3_free(buffer);
    }
  } finally {
    wasm.pstack.restore(stack);
  }
}

/** Copies `bytes` into the wasm heap while `run` runs. */
function withBuffer<T>(sqlite3: Sqlite3Static, bytes: Uint8Array, run: (pointer: number) => T) {
  const pointer = sqlite3.wasm.allocFromTypedArray(bytes);
  try {
    return run(pointer);
  } finally {
    sqlite3.wasm.dealloc(pointer);
  }
}

/** Records the changes to every table of `db` from when it's started until it's ended. */
export class Session {
  readonly #sqlite3: Sqlite3Static;
  readonly #db: Database;
  readonly #pointer: number;

  constructor(sqlite3: Sqlite3Static, db: Database) {
    const { wasm, capi } = sqlite3;
    const stack = wasm.pstack.pointer;
    try {
      const out = wasm.pstack.allocPtr();
      db.checkRc(capi.sqlite3session_create(db, "main", out));
      this.#pointer = wasm.peekPtr(out);
    } finally {
      wasm.pstack.restore(stack);
    }
    this.#sqlite3 = sqlite3;
    this.#db = db;
    try {
      db.checkRc(capi.sqlite3session_attach(this.#pointer, null));
    } catch (error) {
      this.end();
      throw error;
    }
  }

  /**
   * The net changes so far: a row changed and then changed back isn't in
   * them. Empty when there are none.
   */
  changes(): Uint8Array<ArrayBuffer> {
    return takeBuffer(this.#sqlite3, this.#db, (pSize, pBuffer) =>
      this.#sqlite3.capi.sqlite3session_changeset(this.#pointer, pSize, pBuffer),
    );
  }

  /**
   * Whether anything is different from when the session started.
   * (`sqlite3session_isempty` isn't this: it stays false once anything
   * changed, even if it was changed back.)
   */
  hasChanges() {
    return this.changes().length > 0;
  }

  /**
   * Adds to the changes what makes `table` as schema `from` has it into
   * the table as this database has it: the same table, in a database
   * attached to this one.
   */
  addDifference(from: string, table: string) {
    this.#db.checkRc(this.#sqlite3.capi.sqlite3session_diff(this.#pointer, from, table, 0));
  }

  end() {
    this.#sqlite3.capi.sqlite3session_delete(this.#pointer);
  }
}

/**
 * The changes that make the database attached to `db` as schema `from` hold
 * what `db` does: how `db` differs from it, as if recorded while it was
 * changed. Both must have the same tables.
 */
export function difference(sqlite3: Sqlite3Static, db: Database, from: string) {
  const session = new Session(sqlite3, db);
  try {
    const tables = db.selectValues(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite~_%' ESCAPE '~'",
    );
    for (const table of tables) session.addDifference(from, String(table));
    return session.changes();
  } finally {
    session.end();
  }
}

/** Changes that undo `changes`. */
export function invert(sqlite3: Sqlite3Static, db: Database, changes: Uint8Array) {
  return withBuffer(sqlite3, changes, (pChanges) =>
    takeBuffer(sqlite3, db, (pSize, pBuffer) =>
      sqlite3.capi.sqlite3changeset_invert(changes.length, pChanges, pSize, pBuffer),
    ),
  );
}

/** Whether two of a row's values are the same, as SQLite has them. */
function sameValue(a: SqlValue | undefined, b: SqlValue | undefined) {
  if (a instanceof Uint8Array && b instanceof Uint8Array)
    return a.length === b.length && a.every((byte, i) => byte === b[i]);
  return a === b;
}

/** The operation the change `pIter` is at is, and how many columns its table has. */
function changeAt(sqlite3: Sqlite3Static, pIter: WasmPointer) {
  const { capi, wasm } = sqlite3;
  const stack = wasm.pstack.pointer;
  try {
    const [pzTab, pnCol, pOp, pbIndirect] = wasm.pstack.allocPtr(4);
    if (capi.sqlite3changeset_op(pIter, pzTab!, pnCol!, pOp!, pbIndirect!) !== 0)
      throw new Error("Couldn't read a change");
    return { op: Number(wasm.peek(pOp!, "i32")), columns: Number(wasm.peek(pnCol!, "i32")) };
  } finally {
    wasm.pstack.restore(stack);
  }
}

/** Column `column` of the row a DATA or CONFLICT conflict found, as the database has it. */
function conflictingValue(sqlite3: Sqlite3Static, pIter: WasmPointer, column: number) {
  const { capi, wasm } = sqlite3;
  const stack = wasm.pstack.pointer;
  try {
    const ppValue = wasm.pstack.allocPtr();
    if (capi.sqlite3changeset_conflict(pIter, column, ppValue) !== 0)
      throw new Error("Couldn't read a conflicting row");
    return capi.sqlite3_value_to_js(wasm.peekPtr(ppValue));
  } finally {
    wasm.pstack.restore(stack);
  }
}

/**
 * How to take a conflict that's only the change being made already, or
 * null if it's a real one: a delete of a row that's gone is skipped, and so
 * is an insert of a row that's there just as it would be inserted. An
 * update goes ahead if each column it changes is either as it was or
 * already as it's changed to (so changed elsewhere the same way).
 */
function alreadyMade(sqlite3: Sqlite3Static, conflict: number, pIter: WasmPointer) {
  const { capi } = sqlite3;
  const { op, columns } = changeAt(sqlite3, pIter);
  const indexes = Array.from({ length: columns }, (_, i) => i);
  if (conflict === capi.SQLITE_CHANGESET_NOTFOUND && op === capi.SQLITE_DELETE)
    return capi.SQLITE_CHANGESET_OMIT;
  if (conflict === capi.SQLITE_CHANGESET_CONFLICT && op === capi.SQLITE_INSERT) {
    const inserted = indexes.every((i) =>
      sameValue(conflictingValue(sqlite3, pIter, i), capi.sqlite3changeset_new_js(pIter, i)),
    );
    return inserted ? capi.SQLITE_CHANGESET_OMIT : null;
  }
  if (conflict === capi.SQLITE_CHANGESET_DATA && op === capi.SQLITE_UPDATE) {
    const fits = indexes.every((i) => {
      const updated = capi.sqlite3changeset_new_js(pIter, i);
      // A column it doesn't change.
      if (updated === undefined) return true;
      const current = conflictingValue(sqlite3, pIter, i);
      return (
        sameValue(current, updated) || sameValue(current, capi.sqlite3changeset_old_js(pIter, i))
      );
    });
    return fits ? capi.SQLITE_CHANGESET_REPLACE : null;
  }
  return null;
}

/**
 * Applies `changes` exactly as recorded, all or nothing. They already
 * include what triggers and foreign key actions did, so neither runs again:
 * that would do it twice.
 *
 * Throws a ChangesConflictError if the database doesn't hold what the
 * changes expect, leaving it as it was. With `skipMade`, a change the
 * database already holds isn't a conflict, but done (see `alreadyMade`),
 * as when it was made elsewhere too.
 */
export function applyChanges(
  sqlite3: Sqlite3Static,
  db: Database,
  changes: Uint8Array,
  { skipMade = false }: { skipMade?: boolean } = {},
) {
  const { capi, wasm } = sqlite3;
  const conflicts: string[] = [];
  const stack = wasm.pstack.pointer;
  try {
    const pTriggers = wasm.pstack.allocPtr();
    db.checkRc(capi.sqlite3_db_config(db, capi.SQLITE_DBCONFIG_ENABLE_TRIGGER, -1, pTriggers));
    const triggers = Number(wasm.peek(pTriggers, "i32"));
    db.checkRc(capi.sqlite3_db_config(db, capi.SQLITE_DBCONFIG_ENABLE_TRIGGER, 0, 0));
    try {
      const rc = withBuffer(sqlite3, changes, (pChanges) =>
        capi.sqlite3changeset_apply_v2(
          db,
          changes.length,
          pChanges,
          0,
          (_context, conflict, pIter) => {
            const made = skipMade ? alreadyMade(sqlite3, conflict, pIter) : null;
            if (made !== null) return made;
            conflicts.push(CONFLICTS[conflict] ?? String(conflict));
            return capi.SQLITE_CHANGESET_ABORT;
          },
          0,
          0,
          0,
          SQLITE_CHANGESETAPPLY_FKNOACTION,
        ),
      );
      if (conflicts.length > 0) throw new ChangesConflictError(conflicts);
      db.checkRc(rc);
    } finally {
      capi.sqlite3_db_config(db, capi.SQLITE_DBCONFIG_ENABLE_TRIGGER, triggers, 0);
    }
  } finally {
    wasm.pstack.restore(stack);
  }
}
