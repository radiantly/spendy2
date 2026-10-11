import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { ClosedError } from "../../db/rpc.ts";
import { useOpenDatabase } from "../../db/useDatabase.ts";
import {
  GET_TRANSACTION,
  INSERT_CATEGORY,
  LIST_ACCOUNT_NAMES,
  LIST_CATEGORY_NAMES,
  LIST_TRANSACTIONS,
  UPDATE_TRANSACTION,
  type EditableTransactionField,
  type TransactionRow,
} from "../../db/queries/transactions.ts";
import TransactionsTable from "./TransactionsTable.tsx";

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
   * Shows the edit straight away, then writes it to the database. If the
   * write fails, the field goes back to what the database has.
   *
   * A category edit also creates the category if it doesn't exist, in the
   * same transaction: it may be new, or the schema may have just deleted it
   * as unused while the menus still offered it. Either way the menus can be
   * behind, so after any category edit they're refreshed from the database.
   *
   * The database runs queries in the order they're sent, so a save started
   * after this includes the edit, and the read after a failure sees every
   * earlier edit's write.
   */
  function commit(
    rowIndex: number,
    field: EditableTransactionField,
    value: string | number | null,
  ) {
    if (loaded === null) return;
    const { id } = loaded.rows[rowIndex]!;
    const updateRow = (change: (row: TransactionRow) => TransactionRow) =>
      setLoaded(
        (current) =>
          current && {
            ...current,
            rows: current.rows.with(rowIndex, change(current.rows[rowIndex]!)),
          },
      );

    const update = { sql: UPDATE_TRANSACTION[field], bind: [value, id] };

    updateRow((row) => ({ ...row, [field]: value }));
    // Before the write, so the edit is never on screen without being unsaved.
    markDirty();
    const write =
      field === "category" && value !== null
        ? database.batch([{ sql: INSERT_CATEGORY, bind: [value] }, update])
        : database.query(update.sql, update.bind);
    write
      .catch(async (error: unknown) => {
        if (error instanceof ClosedError) throw error;
        toast.error(
          `Couldn't change that transaction: ${error instanceof Error ? error.message : String(error)}`,
        );
        const [stored] = (await database.query(GET_TRANSACTION, [id])) as TransactionRow[];
        // If a later edit changed the field again, that edit's write decides it.
        updateRow((row) => (row[field] === value ? { ...row, [field]: stored![field] } : row));
      })
      .then(async () => {
        if (field !== "category") return;
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
