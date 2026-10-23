/**
 * The transactions page's data: every transaction, read once per database
 * and then kept up to date in place, as reading them all again after each
 * edit would take a while.
 */
import { queryOptions, type QueryClient } from "@tanstack/react-query";
import type { Database } from "./database.ts";
import type { DatabaseHistory, TransactionEdit } from "./databaseContext.ts";
import {
  DELETE_CONVERSION,
  GET_TRANSACTIONS,
  hasPatch,
  INSERT_CATEGORY,
  LIST_ACCOUNTS,
  LIST_CATEGORIES,
  LIST_CURRENCIES,
  LIST_TRANSACTIONS,
  listedTransactions,
  patchFrom,
  UPDATE_TRANSACTION,
  updateBinds,
  type AccountCurrency,
  type Currency,
  type EditableTransactionField,
  type ListedTransaction,
  type TransactionPatch,
} from "./queries/transactions.ts";
import type { CategoryParent } from "./queries/overview.ts";
import { databaseKey } from "./queryClient.ts";
import { ClosedError } from "./rpc.ts";

export type Transactions = {
  rows: ListedTransaction[];
  /** Each row's position in `rows`, by id. Rows keep their positions. */
  positions: ReadonlyMap<string, number>;
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
function patched(
  current: Transactions,
  updates: readonly TransactionUpdate[],
  patchFor: (update: TransactionUpdate, row: ListedTransaction) => Partial<ListedTransaction>,
): Transactions {
  const rows = [...current.rows];
  for (const update of updates) {
    const position = current.positions.get(update.id);
    if (position === undefined) continue;
    rows[position] = { ...rows[position]!, ...patchFor(update, rows[position]!) };
  }
  return { ...current, rows };
}

/** `current` with `stored` in place of the rows with their ids. */
function replaced(current: Transactions, stored: readonly ListedTransaction[]): Transactions {
  const rows = [...current.rows];
  for (const row of stored) {
    const position = current.positions.get(row.id);
    if (position !== undefined) rows[position] = row;
  }
  return { ...current, rows };
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
 * called: it reads again what each changed (also if it failed). Edits only
 * ever change their own rows' transactions, and categories, so those are all
 * there is to read.
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
    const ids = [...new Set(moved.step.about.cells.map(({ id }) => id))];
    Promise.all([
      database.query(GET_TRANSACTIONS, [JSON.stringify(ids)]),
      database.query(LIST_CATEGORIES),
    ]).then(
      ([transactions, categories]) => {
        const stored = listedTransactions(transactions);
        update(queryClient, database, (current) => ({
          ...replaced(current, stored),
          categories: categoriesOf(categories),
        }));
      },
      (error: unknown) => {
        // The database closed (e.g. on logging out).
        if (!(error instanceof ClosedError)) throw error;
      },
    );
  });
}
