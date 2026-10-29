/**
 * The transactions page's data: every transaction, read once per database
 * and then kept up to date in place, as reading them all again after each
 * edit would take a while.
 */
import { queryOptions, type QueryClient } from "@tanstack/react-query";
import type { Database } from "./database.ts";
import type { DatabaseHistory, Edit, TransactionEdit } from "./databaseContext.ts";
import type { Moved } from "./editHistory.ts";
import {
  compareNewestFirst,
  DELETE_CONVERSION,
  DELETE_TRANSACTIONS,
  GET_TRANSACTIONS,
  hasPatch,
  INSERT_CATEGORY,
  INSERT_SOURCE,
  INSERT_TRANSACTION,
  insertBinds,
  LIST_ACCOUNTS,
  LIST_CATEGORIES,
  LIST_CURRENCIES,
  LIST_TRANSACTIONS,
  listedTransactions,
  patchFrom,
  UPDATE_MARK,
  UPDATE_SORT_KEY,
  UPDATE_TRANSACTION,
  updateBinds,
  type AccountCurrency,
  type Currency,
  type EditableTransactionField,
  type ListedTransaction,
  type TransactionMarkField,
  type TransactionPatch,
} from "./queries/transactions.ts";
import type { CategoryParent } from "./queries/overview.ts";
import { databaseKey } from "./queryClient.ts";
import { ClosedError } from "./rpc.ts";
import type { NaiveDate } from "../lib/period.ts";

export type Transactions = {
  /**
   * Every transaction read, or added since, each at the position it was read
   * or added at, removed ones too (see `removed`).
   */
  rows: ListedTransaction[];
  /** Each row's position in `rows`, by id. Rows keep their positions. */
  positions: ReadonlyMap<string, number>;
  /**
   * The positions of the rows removed since (deleted, or adds undone), which
   * aren't transactions any more. Each keeps its place and how it was, so a
   * view worked out while it's gone still has a place for it, should it come
   * back (the delete undone, or the add redone). See `existing`.
   */
  removed: ReadonlySet<number>;
  /**
   * New each time the transactions are read, which gives them new
   * positions: positions from another read don't apply to these rows.
   */
  read: symbol;
  /**
   * The latest undo or redo since they were read, once the rows show it
   * (see `keepTransactionsInSync`): it can add or remove rows.
   */
  lastUndoOrRedo: Moved<Edit> | null;
  /** With their parents, in the order the cell menus list them (see the queries). */
  categories: readonly CategoryParent[];
  accounts: readonly AccountCurrency[];
  currencies: readonly Currency[];
};

/** A field of a transaction to set, as the columns it sets. */
export type TransactionUpdate = {
  id: string;
  field: EditableTransactionField;
  patch: TransactionPatch;
};

/** The categories from a `LIST_CATEGORIES` query. */
function categoriesOf(rows: Record<string, unknown>[]) {
  // The query's columns match the type, and the schema guarantees their types.
  return rows as CategoryParent[];
}

/** `database`'s transactions, read once and then updated in place. */
export function transactionsQuery(database: Database) {
  return queryOptions({
    queryKey: [...databaseKey(database), "transactions"],
    queryFn: async (): Promise<Transactions> => {
      const [transactions, categories, accounts, currencies] = await Promise.all([
        database.query(LIST_TRANSACTIONS),
        database.query(LIST_CATEGORIES),
        database.query(LIST_ACCOUNTS),
        database.query(LIST_CURRENCIES),
      ]);
      const rows = listedTransactions(transactions);
      return {
        rows,
        positions: new Map(rows.map((row, position) => [row.id, position])),
        removed: new Set(),
        read: Symbol("read"),
        lastUndoOrRedo: null,
        categories: categoriesOf(categories),
        // The queries' columns match the row types, and the schema guarantees their types.
        accounts: accounts as AccountCurrency[],
        currencies: currencies as Currency[],
      };
    },
    meta: { updatedInPlace: true },
    // Rows are replaced as they change, so there's nothing to compare.
    structuralSharing: false,
  });
}

/** The transactions there are: `transactions`' rows, but those removed. */
export function existing(transactions: Transactions) {
  const { rows, removed } = transactions;
  return removed.size === 0 ? rows : rows.filter((_, position) => !removed.has(position));
}

/** Updates `database`'s transactions where they've been read. */
function update(
  queryClient: QueryClient,
  database: Database,
  change: (current: Transactions) => Transactions,
) {
  queryClient.setQueryData(transactionsQuery(database).queryKey, (current) =>
    current === undefined ? current : change(current),
  );
}

/** `current` with each update's row patched, in turn, with what `patchFor` returns for it. */
function patched<Update extends { id: string }>(
  current: Transactions,
  updates: readonly Update[],
  patchFor: (update: Update, row: ListedTransaction) => Partial<ListedTransaction>,
): Transactions {
  const rows = [...current.rows];
  for (const update of updates) {
    const position = current.positions.get(update.id);
    if (position === undefined) continue;
    rows[position] = { ...rows[position]!, ...patchFor(update, rows[position]!) };
  }
  return { ...current, rows };
}

/** `positions` with `ids` added, at the positions after the last of `rows`. */
function withPositions(
  positions: ReadonlyMap<string, number>,
  ids: readonly string[],
  rows: number,
) {
  if (ids.length === 0) return positions;
  const added = new Map(positions);
  ids.forEach((id, index) => added.set(id, rows + index));
  return added;
}

/**
 * `current` with the transactions with `ids` as `stored` has them: each
 * replaced, put back if it was removed, added after the rest if it's new,
 * and removed if it isn't stored.
 */
function synced(
  current: Transactions,
  ids: readonly string[],
  stored: readonly ListedTransaction[],
): Transactions {
  const storedById = new Map(stored.map((row) => [row.id, row]));
  const added = ids.filter((id) => storedById.has(id) && !current.positions.has(id));
  const positions = withPositions(current.positions, added, current.rows.length);
  const rows = [...current.rows];
  const removed = new Set(current.removed);
  for (const id of ids) {
    const position = positions.get(id);
    if (position === undefined) continue;
    const row = storedById.get(id);
    if (row === undefined) removed.add(position);
    else {
      rows[position] = row;
      removed.delete(position);
    }
  }
  return { ...current, rows, positions, removed };
}

/**
 * What `patch` changes in `row`: its fields, and setting the currency also
 * drops the conversion to it (see DELETE_CONVERSION).
 */
function changedBy(row: ListedTransaction, patch: TransactionPatch): Partial<ListedTransaction> {
  if (!("currency" in patch)) return patch;
  const conversions = Object.entries(row.conversions).filter(
    ([currency]) => currency !== patch.currency,
  );
  return { ...patch, conversions: Object.fromEntries(conversions) };
}

/** `stored`'s values for what `patch` changes (see `changedBy`), to put them back. */
function storedFor(stored: ListedTransaction, patch: TransactionPatch): Partial<ListedTransaction> {
  const fields = patchFrom(stored, patch);
  return "currency" in patch ? { ...fields, conversions: stored.conversions } : fields;
}

async function refreshCategories(queryClient: QueryClient, database: Database) {
  const categories = categoriesOf(await database.query(LIST_CATEGORIES));
  update(queryClient, database, (current) => ({ ...current, categories }));
}

/**
 * Shows `updates` straight away, then writes them to the database, all in
 * one transaction, as one step to undo, which `description` describes. If
 * the write fails, the fields go back to what the database has, there's
 * nothing to undo, and this rejects with why.
 *
 * Setting a category also creates it if it doesn't exist, in the same
 * transaction: it may be new, or the schema may have just deleted it as
 * unused while the menus still offered it. Either way the menus can be
 * behind, so after any category change they're refreshed from the database.
 * Setting a currency also deletes the transaction's conversion to it, if
 * there is one, as a transaction can't be converted to its own currency.
 *
 * The database runs queries in the order they're sent, so a save started
 * after this includes the changes, and the read after a failure sees every
 * earlier write.
 */
export async function commitTransactions(
  queryClient: QueryClient,
  database: Database,
  history: DatabaseHistory,
  updates: readonly TransactionUpdate[],
  description: string,
) {
  const statements = updates.flatMap(({ id, field, patch }) => [
    ...("category" in patch && patch.category !== null
      ? [{ sql: INSERT_CATEGORY, bind: [patch.category] }]
      : []),
    ...("currency" in patch ? [{ sql: DELETE_CONVERSION, bind: [id, patch.currency] }] : []),
    { sql: UPDATE_TRANSACTION[field], bind: updateBinds(patch, id) },
  ]);
  const edit: TransactionEdit = {
    kind: "transaction",
    cells: updates.map(({ id, field }) => ({ id, field })),
    transactions: [...new Set(updates.map(({ id }) => id))],
    description,
  };

  update(queryClient, database, (current) =>
    patched(current, updates, ({ patch }, row) => changedBy(row, patch)),
  );
  let failure: { error: unknown } | undefined;
  try {
    try {
      // Asked for before anything awaits, so the database counts the change
      // as unsaved before it's on screen, and an undo pressed while it's
      // written undoes it.
      const written = database.batch(statements);
      history.record({ changes: written, about: edit });
      await written;
    } catch (error) {
      if (error instanceof ClosedError) throw error;
      failure = { error };
      const ids = updates.map(({ id }) => id);
      const stored = new Map(
        listedTransactions(await database.query(GET_TRANSACTIONS, [JSON.stringify(ids)])).map(
          (row) => [row.id, row],
        ),
      );
      // If a later edit changed the field again, that edit's write decides
      // it. A field's columns go back together, so they always match.
      update(queryClient, database, (current) =>
        patched(current, updates, ({ patch }, row) =>
          hasPatch(row, patch) ? storedFor(stored.get(row.id)!, patch) : {},
        ),
      );
    }
    if (updates.some(({ field }) => field === "category"))
      await refreshCategories(queryClient, database);
  } catch (error) {
    // The database closed (e.g. on logging out), and the page with it.
    if (error instanceof ClosedError) return;
    throw error;
  }
  if (failure) throw failure.error;
}

/**
 * Keeps `database`'s transactions up to date with every undo and redo in
 * `history`, whichever page it happens on, until the returned function is
 * called: it reads again what each changed (also if it failed), which may
 * add or remove transactions. Edits only ever change the transactions they
 * list, and categories, so those are all there is to read.
 */
export function keepTransactionsInSync(
  queryClient: QueryClient,
  database: Database,
  history: DatabaseHistory,
) {
  return history.subscribe(() => {
    const moved = history.latest;
    if (moved === null || moved.step.about.kind !== "transaction") return;
    // There's an edit to undo or redo only once they've been read for the page.
    if (queryClient.getQueryData(transactionsQuery(database).queryKey) === undefined) return;
    const ids = moved.step.about.transactions;
    Promise.all([
      database.query(GET_TRANSACTIONS, [JSON.stringify(ids)]),
      database.query(LIST_CATEGORIES),
    ]).then(
      ([transactions, categories]) => {
        const stored = listedTransactions(transactions);
        update(queryClient, database, (current) => ({
          ...synced(current, ids, stored),
          categories: categoriesOf(categories),
          lastUndoOrRedo: moved,
        }));
      },
      (error: unknown) => {
        // The database closed (e.g. on logging out).
        if (!(error instanceof ClosedError)) throw error;
      },
    );
  });
}

/** A transaction to add (see `addTransaction`). It has no category. */
export type NewTransaction = Pick<
  ListedTransaction,
  "naive_date" | "timestamp" | "account_name" | "currency" | "amount" | "counterparty" | "remarks"
>;

/**
 * Where a new transaction goes among its day's: next to one at the same
 * time, on its newer or older side, or the newest of those at its time
 * (of those without a time, if it has none).
 */
export type Placement =
  | { kind: "beside"; id: string; side: "newer" | "older" }
  | { kind: "newest" };

/** Every field a transaction has a cell for. */
const FIELDS = Object.keys(UPDATE_TRANSACTION) as EditableTransactionField[];

/**
 * The source of the transactions added here on `day`, as `[hash, remarks]`:
 * one a day, so a day's can be told apart from imports, or removed,
 * together. Its hash is its remarks' SHA-256.
 */
async function addedSource(day: NaiveDate) {
  const remarks = `Spendy2 Web UI - ${day}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(remarks));
  return [new Uint8Array(digest), remarks] as const;
}

/**
 * `added`'s day's transactions, oldest first, with `added` among them where
 * `placement` puts it.
 */
function dayWith(transactions: Transactions, added: ListedTransaction, placement: Placement) {
  const day = existing(transactions)
    .filter((row) => row.naive_date === added.naive_date)
    .sort((x, y) => compareNewestFirst(y, x));
  let at: number;
  if (placement.kind === "beside") {
    const index = day.findIndex(({ id }) => id === placement.id);
    if (index === -1 || day[index]!.timestamp !== added.timestamp)
      throw new Error("A transaction can only be added beside one on its day, at its time");
    at = placement.side === "newer" ? index + 1 : index;
  } else {
    // After those at its time or earlier; those without a time are the earliest.
    const later = day.findIndex(
      (row) => (row.timestamp ?? -Infinity) > (added.timestamp ?? -Infinity),
    );
    at = later === -1 ? day.length : later;
  }
  return day.toSpliced(at, 0, added);
}

/**
 * Adds `transaction` among its day's where `placement` puts it, numbering
 * the day's transactions again from 1, oldest first (see the schema's
 * sort_key), in one transaction, as one step to undo, which `description`
 * describes. It's from the source of the transactions added here `today`
 * (see `addedSource`), made with the first of them.
 *
 * It's in the transactions as soon as it's asked to be written, so the adds
 * and edits after it see its day numbered with it. Resolves with its id
 * once it's written, or null if the database closed first. If the write
 * fails, it's taken out again, the day's numbers go back to what the
 * database has, and this rejects with why.
 */
export async function addTransaction(
  queryClient: QueryClient,
  database: Database,
  history: DatabaseHistory,
  {
    transaction,
    placement,
    description,
    today,
  }: { transaction: NewTransaction; placement: Placement; description: string; today: NaiveDate },
): Promise<string | null> {
  const [source, remarks] = await addedSource(today);
  // Nothing awaits from here until it's asked to be written, so its day is
  // numbered as the transactions are then.
  const { queryKey } = transactionsQuery(database);
  const current = queryClient.getQueryData(queryKey);
  if (current === undefined) throw new Error("The transactions haven't been read");
  const currency = current.currencies.find(({ code }) => code === transaction.currency);
  if (currency === undefined) throw new Error(`There's no currency ${transaction.currency}`);
  const id = crypto.randomUUID();
  const day = dayWith(
    current,
    {
      ...transaction,
      id,
      decimals: currency.stored_decimals,
      category: null,
      sort_key: 0,
      transfer_account: null,
      duplicate_of: null,
      conversions: {},
    },
    placement,
  );
  const numbered = day.map((row, index) => ({ ...row, sort_key: index + 1 }));
  const added = numbered.find((row) => row.id === id)!;
  // Only the numbers that change are written.
  const moved = numbered.filter(
    (row, index) => row.id !== id && row.sort_key !== day[index]!.sort_key,
  );
  const edit: TransactionEdit = {
    kind: "transaction",
    // All of it, for a redo to select.
    cells: FIELDS.map((field) => ({ id, field })),
    transactions: [id, ...moved.map((row) => row.id)],
    description,
  };
  const statements = [
    { sql: INSERT_SOURCE, bind: [source, remarks] },
    ...moved.map((row) => ({ sql: UPDATE_SORT_KEY, bind: [row.sort_key, row.id] })),
    { sql: INSERT_TRANSACTION, bind: insertBinds(added, source) },
  ];

  const rows = [...current.rows, added];
  for (const row of moved) rows[current.positions.get(row.id)!] = row;
  queryClient.setQueryData(queryKey, {
    ...current,
    rows,
    positions: withPositions(current.positions, [id], current.rows.length),
  });
  let failure: { error: unknown } | undefined;
  try {
    try {
      // As commitTransactions asks.
      const written = database.batch(statements);
      history.record({ changes: written, about: edit });
      await written;
    } catch (error) {
      if (error instanceof ClosedError) throw error;
      failure = { error };
      const stored = listedTransactions(
        await database.query(GET_TRANSACTIONS, [JSON.stringify(moved.map((row) => row.id))]),
      );
      const numbers = new Map(moved.map((row) => [row.id, row.sort_key]));
      update(queryClient, database, (latest) => {
        const rows = [...latest.rows];
        const removed = new Set(latest.removed);
        const position = latest.positions.get(id);
        if (position !== undefined) removed.add(position);
        // If a later add numbered the day again, its write decides the numbers.
        for (const { id, sort_key } of stored) {
          const position = latest.positions.get(id);
          if (position === undefined) continue;
          const row = rows[position]!;
          if (row.sort_key === numbers.get(id)) rows[position] = { ...row, sort_key };
        }
        return { ...latest, rows, removed };
      });
    }
  } catch (error) {
    // The database closed (e.g. on logging out), and the page with it.
    if (error instanceof ClosedError) return null;
    throw error;
  }
  if (failure) throw failure.error;
  return id;
}

/**
 * Takes the transactions with `ids` out straight away, then deletes them
 * from the database, in one transaction, as one step to undo, which
 * `description` describes. Their rows keep their places (see `removed`),
 * so an undo puts them back where they were.
 *
 * The schema deletes their conversions with them, stops others being
 * duplicates of them, and deletes categories only they used, so those
 * others change here too, and the categories are read again. If the write
 * fails, they're put back as the database has them, there's nothing to
 * undo, and this rejects with why.
 */
export async function deleteTransactions(
  queryClient: QueryClient,
  database: Database,
  history: DatabaseHistory,
  ids: readonly string[],
  description: string,
) {
  const { queryKey } = transactionsQuery(database);
  const current = queryClient.getQueryData(queryKey);
  if (current === undefined) throw new Error("The transactions haven't been read");
  const deleted = new Set(ids);
  const positions = ids.map((id) => current.positions.get(id)!);
  const usedCategories = positions.some((position) => current.rows[position]!.category !== null);
  const duplicates = existing(current)
    .filter(
      ({ id, duplicate_of }) =>
        duplicate_of !== null && deleted.has(duplicate_of) && !deleted.has(id),
    )
    .map(({ id }) => id);
  const edit: TransactionEdit = {
    kind: "transaction",
    // All of them, for an undo to select.
    cells: ids.flatMap((id) => FIELDS.map((field) => ({ id, field }))),
    transactions: [...ids, ...duplicates],
    description,
  };

  const rows = [...current.rows];
  for (const id of duplicates) {
    const position = current.positions.get(id)!;
    rows[position] = { ...rows[position]!, duplicate_of: null };
  }
  queryClient.setQueryData(queryKey, {
    ...current,
    rows,
    removed: new Set([...current.removed, ...positions]),
  });
  let failure: { error: unknown } | undefined;
  try {
    try {
      // As commitTransactions asks.
      const written = database.batch([{ sql: DELETE_TRANSACTIONS, bind: [JSON.stringify(ids)] }]);
      history.record({ changes: written, about: edit });
      await written;
    } catch (error) {
      if (error instanceof ClosedError) throw error;
      failure = { error };
      const stored = listedTransactions(
        await database.query(GET_TRANSACTIONS, [JSON.stringify(edit.transactions)]),
      );
      const storedById = new Map(stored.map((row) => [row.id, row]));
      update(queryClient, database, (latest) => {
        const restored = synced(latest, ids, stored);
        const next = [...restored.rows];
        // If a later edit marked one again, that edit's write decides it.
        for (const id of duplicates) {
          const position = restored.positions.get(id)!;
          const row = next[position]!;
          if (row.duplicate_of === null)
            next[position] = { ...row, duplicate_of: storedById.get(id)?.duplicate_of ?? null };
        }
        return { ...restored, rows: next };
      });
    }
    if (usedCategories) await refreshCategories(queryClient, database);
  } catch (error) {
    // The database closed (e.g. on logging out), and the page with it.
    if (error instanceof ClosedError) return;
    throw error;
  }
  if (failure) throw failure.error;
}

/** A mark to set on a transaction: its `field` set to `value`. */
export type TransactionMark = { id: string; field: TransactionMarkField; value: string | null };

/** What `mark` changes in its transaction's row. */
function markedBy({ field, value }: Pick<TransactionMark, "field" | "value">) {
  return field === "duplicate_of" ? { duplicate_of: value } : { transfer_account: value };
}

/**
 * Shows `marks` straight away, then writes them to the database, in one
 * transaction, as one step to undo, which `description` describes. `marked`
 * are the transactions that were marked, which an undo or redo selects;
 * others the marks change (a transfer's other side, say) aren't selected. If
 * the write fails, the marks go back to what the database has, there's
 * nothing to undo, and this rejects with why.
 */
export async function markTransactions(
  queryClient: QueryClient,
  database: Database,
  history: DatabaseHistory,
  {
    marks,
    marked,
    description,
  }: { marks: readonly TransactionMark[]; marked: readonly string[]; description: string },
) {
  const ids = marks.map(({ id }) => id);
  const edit: TransactionEdit = {
    kind: "transaction",
    // All of them, for an undo or redo to select.
    cells: marked.flatMap((id) => FIELDS.map((field) => ({ id, field }))),
    transactions: [...new Set([...marked, ...ids])],
    description,
  };

  update(queryClient, database, (current) => patched(current, marks, markedBy));
  let failure: { error: unknown } | undefined;
  try {
    try {
      // As commitTransactions asks.
      const written = database.batch(
        marks.map(({ id, field, value }) => ({ sql: UPDATE_MARK[field], bind: [value, id] })),
      );
      history.record({ changes: written, about: edit });
      await written;
    } catch (error) {
      if (error instanceof ClosedError) throw error;
      failure = { error };
      const stored = new Map(
        listedTransactions(await database.query(GET_TRANSACTIONS, [JSON.stringify(ids)])).map(
          (row) => [row.id, row],
        ),
      );
      // If a later mark changed one again, that mark's write decides it.
      update(queryClient, database, (current) =>
        patched(current, marks, ({ id, field, value }, row) => {
          const before = stored.get(id);
          return before && row[field] === value ? markedBy({ field, value: before[field] }) : {};
        }),
      );
    }
  } catch (error) {
    // The database closed (e.g. on logging out), and the page with it.
    if (error instanceof ClosedError) return;
    throw error;
  }
  if (failure) throw failure.error;
}
