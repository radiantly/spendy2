import { useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { ClosedError } from "../../db/rpc.ts";
import { useHoldUpdates, useOpenDatabase } from "../../db/useDatabase.ts";
import {
  GET_TRANSACTIONS,
  INSERT_CATEGORY,
  LIST_ACCOUNTS,
  LIST_CATEGORY_NAMES,
  LIST_TRANSACTIONS,
  listedTransactions,
  UPDATE_TRANSACTION,
  updateBinds,
  type AccountCurrency,
  type ListedTransaction,
} from "../../db/queries/transactions.ts";
import type { TransactionEdit } from "../../db/databaseContext.ts";
import { useBreakpoint } from "../../hooks/useBreakpoint.ts";
import { useUndoRedo } from "../shell/historyKeys.ts";
import { describeEdit } from "./describe.ts";
import { hasPatch, patchFrom } from "./patch.ts";
import TransactionsList from "./TransactionsList.tsx";
import TransactionsTable, { type TransactionChange } from "./TransactionsTable.tsx";

type Loaded = {
  rows: ListedTransaction[];
  /** In the order the cell menus list them (see the queries). */
  categories: readonly string[];
  accounts: readonly AccountCurrency[];
};

/** The names from a `SELECT name …` query. */
function namesOf(rows: Record<string, unknown>[]) {
  return rows.map(({ name }) => String(name));
}

function TransactionsPage() {
  const { database, history } = useOpenDatabase();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // A newer version would replace the rows under the edit, losing it.
  const [editing, setEditing] = useState(false);
  useHoldUpdates(editing);
  // Undoing and redoing can happen from any page.
  const moved = useSyncExternalStore(history.subscribe, () => history.latest);
  const undoOrRedo = useUndoRedo(history);
  // The table's columns fit from md; narrower, the transactions are a list.
  const tableFits = useBreakpoint("md");

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      database.query(LIST_TRANSACTIONS),
      database.query(LIST_CATEGORY_NAMES),
      database.query(LIST_ACCOUNTS),
    ]).then(
      ([transactions, categories, accounts]) => {
        if (cancelled) return;
        setLoaded({
          rows: listedTransactions(transactions),
          categories: namesOf(categories),
          // The query's columns match the row type, and the schema
          // guarantees their types.
          accounts: accounts as AccountCurrency[],
        });
      },
      () => {
        if (!cancelled) setLoadFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [database]);

  // Shows what an undo or redo changed, as the database now has it (also if
  // it failed). The edits only ever change their own rows' transactions, and
  // categories, so those are all there is to read. While the page is hidden,
  // this waits for it to be shown again.
  useEffect(() => {
    if (moved === null || moved.step.about.kind !== "transaction") return;
    let cancelled = false;
    const ids = [...new Set(moved.step.about.cells.map(({ id }) => id))];
    Promise.all([
      database.query(GET_TRANSACTIONS, [JSON.stringify(ids)]),
      database.query(LIST_CATEGORY_NAMES),
    ]).then(
      ([transactions, categories]) => {
        if (cancelled) return;
        const stored = new Map(listedTransactions(transactions).map((row) => [row.id, row]));
        setLoaded(
          (current) =>
            current && {
              ...current,
              rows: current.rows.map((row) => stored.get(row.id) ?? row),
              categories: namesOf(categories),
            },
        );
      },
      (error: unknown) => {
        // The database closed (e.g. on logging out), and this page with it.
        if (!(error instanceof ClosedError)) throw error;
      },
    );
    return () => {
      cancelled = true;
    };
  }, [database, moved]);

  async function refreshCategories() {
    const categories = namesOf(await database.query(LIST_CATEGORY_NAMES));
    setLoaded((current) => current && { ...current, categories });
  }

  /**
   * Shows the changes straight away, then writes them to the database, all
   * in one transaction, as one step to undo. If the write fails, the fields
   * go back to what the database has, and there's nothing to undo.
   *
   * Setting a category also creates it if it doesn't exist, in the same
   * transaction: it may be new, or the schema may have just deleted it as
   * unused while the menus still offered it. Either way the menus can be
   * behind, so after any category change they're refreshed from the database.
   *
   * The database runs queries in the order they're sent, so a save started
   * after this includes the changes, and the read after a failure sees every
   * earlier write.
   */
  async function commit(changes: readonly TransactionChange[]) {
    if (loaded === null || changes.length === 0) return;
    const ids = changes.map(({ rowIndex }) => loaded.rows[rowIndex]!.id);
    const apply = (
      patchFor: (change: TransactionChange, row: ListedTransaction) => Partial<ListedTransaction>,
    ) =>
      setLoaded((current) => {
        if (current === null) return current;
        const rows = [...current.rows];
        for (const change of changes) {
          const row = rows[change.rowIndex]!;
          rows[change.rowIndex] = { ...row, ...patchFor(change, row) };
        }
        return { ...current, rows };
      });

    const statements = changes.flatMap(({ field, patch }, i) => [
      ...("category" in patch && patch.category !== null
        ? [{ sql: INSERT_CATEGORY, bind: [patch.category] }]
        : []),
      { sql: UPDATE_TRANSACTION[field], bind: updateBinds(patch, ids[i]!) },
    ]);

    // Described as the rows are before it.
    const edit: TransactionEdit = {
      kind: "transaction",
      cells: changes.map(({ field }, i) => ({ id: ids[i]!, field })),
      description: describeEdit(changes, loaded.rows, loaded.categories),
    };

    apply((change) => change.patch);
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
        toast.error(
          `Couldn't change ${changes.length === 1 ? "that transaction" : "those transactions"}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        const stored = new Map(
          listedTransactions(await database.query(GET_TRANSACTIONS, [JSON.stringify(ids)])).map(
            (row) => [row.id, row],
          ),
        );
        // If a later edit changed the field again, that edit's write decides
        // it. A field's columns go back together, so they always match.
        apply((change, row) => {
          if (!hasPatch(row, change.patch)) return {};
          return patchFrom(stored.get(row.id)!, change.patch);
        });
      }
      if (changes.some(({ field }) => field === "category")) await refreshCategories();
    } catch (error) {
      // The database closed (e.g. on logging out), and this page with it.
      if (!(error instanceof ClosedError)) throw error;
    }
  }

  if (loadFailed)
    return (
      <p role="alert" className="m-auto text-ink">
        Couldn't load your transactions.
      </p>
    );

  if (loaded === null)
    return (
      <p role="status" className="m-auto text-sm text-ink-muted">
        Loading transactions…
      </p>
    );

  return (
    <div className="flex flex-col gap-4 pb-8">
      <h1 className="px-4 font-display text-3xl font-bold tracking-tight lg:px-8">Transactions</h1>
      {loaded.rows.length === 0 ? (
        <p className="px-4 text-ink-muted lg:px-8">No transactions yet.</p>
      ) : !tableFits ? (
        <TransactionsList transactions={loaded.rows} accounts={loaded.accounts} />
      ) : (
        <TransactionsTable
          rows={loaded.rows}
          categories={loaded.categories}
          accounts={loaded.accounts.map(({ name }) => name)}
          onCommit={(changes) => void commit(changes)}
          onEditingChange={setEditing}
          lastUndoOrRedo={moved}
          onUndoOrRedo={undoOrRedo}
        />
      )}
    </div>
  );
}

export default TransactionsPage;
