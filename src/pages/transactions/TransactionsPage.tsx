import { useState, useSyncExternalStore } from "react";
import {
  keepPreviousData,
  usePrefetchQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { commitTransactions, transactionsQuery, type Transactions } from "../../db/transactions.ts";
import { useHoldUpdates, useOpenDatabase } from "../../db/useDatabase.ts";
import { useBreakpoint } from "../../hooks/useBreakpoint.ts";
import { today } from "../../lib/period.ts";
import { useUndoRedo } from "../shell/historyKeys.ts";
import { ColumnMenu } from "./ColumnMenus.tsx";
import { describeEdit } from "./describe.ts";
import TransactionsList from "./TransactionsList.tsx";
import TransactionsTable, { type TransactionChange } from "./TransactionsTable.tsx";
import { DEFAULT_VIEW, filterValues, viewOrder, type TransactionsView } from "./view.ts";

/** The transactions a view showed, as positions in the rows it was worked out from. */
type Shown = {
  view: TransactionsView;
  positions: Transactions["positions"];
  order: number[];
};

function TransactionsPage() {
  const { database, history } = useOpenDatabase();
  const queryClient = useQueryClient();
  const query = transactionsQuery(database);
  // Started while rendering, so they load while the page is hidden too: its
  // effects, where useQuery would start it, only run once it's shown.
  usePrefetchQuery(query);
  // The rows stay up until a newer version of the database's are ready.
  const { data: loaded, isError } = useQuery({
    ...query,
    placeholderData: keepPreviousData,
  });
  // A newer version would replace the rows under the edit, losing it.
  const [editing, setEditing] = useState(false);
  useHoldUpdates(editing);
  // Undoing and redoing can happen from any page.
  const moved = useSyncExternalStore(history.subscribe, () => history.latest);
  const undoOrRedo = useUndoRedo(history);
  // The table's columns fit from md; narrower, the transactions are a list.
  const tableFits = useBreakpoint("md");
  // How the table's header menus sort and filter the transactions.
  const [view, setView] = useState(DEFAULT_VIEW);
  // The transactions the table shows. Worked out again when the view
  // changes, or when the rows are read again, but not when an edit (or an
  // undo of one) changes them: an edited row stays where it is, even if
  // it no longer belongs there, until the view changes, rather than moving
  // away from under the edit.
  const [shown, setShown] = useState<Shown | null>(null);

  if (isError)
    return (
      <p role="alert" className="m-auto text-ink">
        Couldn't load your transactions.
      </p>
    );

  if (loaded === undefined)
    return (
      <p role="status" className="m-auto text-sm text-ink-muted">
        Loading transactions…
      </p>
    );

  const accounts = loaded.accounts.map(({ name }) => name);
  const categories = loaded.categories.map(({ name }) => name);
  const names = { accounts, categories };
  const { currencies } = loaded;
  // Edits keep the rows' positions: only reading them again makes new ones.
  const current =
    shown !== null && shown.view === view && shown.positions === loaded.positions ? shown : null;
  const order = current?.order ?? viewOrder(loaded.rows, view, names, today());
  if (current === null) setShown({ view, positions: loaded.positions, order });
  const rows = order.map((position) => loaded.rows[position]!);
  const values = filterValues(loaded.rows, names);

  /** Stores the changes, saying so if they couldn't be (see `commitTransactions`). */
  const commit = (changes: readonly TransactionChange[]) => {
    if (changes.length === 0) return;
    const updates = changes.map(({ rowIndex, field, patch }) => ({
      id: rows[rowIndex]!.id,
      field,
      patch,
    }));
    // Described as the rows are before it.
    const description = describeEdit(changes, rows, { ...names, currencies });
    commitTransactions(queryClient, database, history, updates, description).catch(
      (error: unknown) => {
        toast.error(
          `Couldn't change ${changes.length === 1 ? "that transaction" : "those transactions"}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      },
    );
  };

  return (
    <div className="flex flex-col gap-4 pb-8">
      <h1 className="px-4 font-display text-3xl font-bold tracking-tight lg:px-8">Transactions</h1>
      {loaded.rows.length === 0 ? (
        <p className="px-4 text-ink-muted lg:px-8">No transactions yet.</p>
      ) : !tableFits ? (
        <TransactionsList transactions={loaded.rows} accounts={loaded.accounts} />
      ) : (
        <TransactionsTable
          rows={rows}
          categories={categories}
          accounts={accounts}
          currencies={currencies}
          onCommit={commit}
          onEditingChange={setEditing}
          lastUndoOrRedo={moved}
          onUndoOrRedo={undoOrRedo}
          menus={{
            sort: view.sort,
            render: (column, header) => (
              <ColumnMenu
                column={column}
                header={header}
                view={view}
                onViewChange={setView}
                accounts={accounts}
                categories={loaded.categories}
                values={values}
              />
            ),
          }}
        />
      )}
    </div>
  );
}

export default TransactionsPage;
