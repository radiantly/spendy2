import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { ClosedError } from "../../db/rpc.ts";
import { useOpenDatabase } from "../../db/useDatabase.ts";
import {
  GET_TRANSACTIONS,
  INSERT_CATEGORY,
  LIST_ACCOUNT_NAMES,
  LIST_CATEGORY_NAMES,
  LIST_TRANSACTIONS,
  UPDATE_TRANSACTION,
  type TransactionRow,
} from "../../db/queries/transactions.ts";
import TransactionsTable, { type TransactionChange } from "./TransactionsTable.tsx";

type Loaded = {
  rows: TransactionRow[];
  /** In the order the cell menus list them (see the queries). */
  categories: readonly string[];
  accounts: readonly string[];
};

/** The names from a `SELECT name …` query. */
function namesOf(rows: Record<string, unknown>[]) {
  return rows.map(({ name }) => String(name));
}

function TransactionsPage() {
  const { database, markDirty } = useOpenDatabase();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      database.query(LIST_TRANSACTIONS),
      database.query(LIST_CATEGORY_NAMES),
      database.query(LIST_ACCOUNT_NAMES),
    ]).then(
      ([rows, categories, accounts]) => {
        if (cancelled) return;
        setLoaded({
          // The query's columns match TransactionRow, and the schema
          // guarantees their types.
          rows: rows as TransactionRow[],
          categories: namesOf(categories),
          accounts: namesOf(accounts),
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

  /**
   * Shows the changes straight away, then writes them to the database, all
   * in one transaction. If the write fails, the fields go back to what the
   * database has.
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
  function commit(changes: readonly TransactionChange[]) {
    if (loaded === null || changes.length === 0) return;
    const ids = changes.map(({ rowIndex }) => loaded.rows[rowIndex]!.id);
    const apply = (value: (change: TransactionChange, row: TransactionRow) => unknown) =>
      setLoaded((current) => {
        if (current === null) return current;
        const rows = [...current.rows];
        for (const change of changes) {
          const row = rows[change.rowIndex]!;
          rows[change.rowIndex] = { ...row, [change.field]: value(change, row) };
        }
        return { ...current, rows };
      });

    const statements = changes.flatMap(({ field, value }, i) => [
      ...(field === "category" && value !== null ? [{ sql: INSERT_CATEGORY, bind: [value] }] : []),
      { sql: UPDATE_TRANSACTION[field], bind: [value, ids[i]!] },
    ]);
    const setsCategory = changes.some(({ field }) => field === "category");

    apply((change) => change.value);
    // Before the write, so a change is never on screen without being unsaved.
    markDirty();
    database
      .batch(statements)
      .catch(async (error: unknown) => {
        if (error instanceof ClosedError) throw error;
        toast.error(
          `Couldn't change ${changes.length === 1 ? "that transaction" : "those transactions"}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        const stored = new Map(
          ((await database.query(GET_TRANSACTIONS, [JSON.stringify(ids)])) as TransactionRow[]).map(
            (row) => [row.id, row],
          ),
        );
        // If a later edit changed a field again, that edit's write decides it.
        apply((change, row) =>
          row[change.field] === change.value
            ? stored.get(row.id)![change.field]
            : row[change.field],
        );
      })
      .then(async () => {
        if (!setsCategory) return;
        const categories = namesOf(await database.query(LIST_CATEGORY_NAMES));
        setLoaded((current) => current && { ...current, categories });
      })
      .catch((error: unknown) => {
        // The database closed (e.g. on logging out), and this page with it.
        if (!(error instanceof ClosedError)) throw error;
      });
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
      <div className="flex items-baseline justify-between gap-4 px-4 lg:px-8">
        <h1 className="font-display text-3xl font-bold tracking-tight">Transactions</h1>
        <p className="font-mono text-xs tracking-widest text-ink-muted uppercase">
          {loaded.rows.length.toLocaleString("en-US")} transactions
        </p>
      </div>
      {loaded.rows.length === 0 ? (
        <p className="px-4 text-ink-muted lg:px-8">No transactions yet.</p>
      ) : (
        <TransactionsTable
          rows={loaded.rows}
          categories={loaded.categories}
          accounts={loaded.accounts}
          onCommit={commit}
        />
      )}
    </div>
  );
}

export default TransactionsPage;
