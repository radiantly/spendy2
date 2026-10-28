import { useState, useSyncExternalStore } from "react";
import {
  keepPreviousData,
  usePrefetchQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import {
  addTransaction,
  commitTransactions,
  deleteTransactions,
  existing,
  transactionsQuery,
  type Placement,
  type Transactions,
} from "../../db/transactions.ts";
import { useHoldUpdates, useOpenDatabase } from "../../db/useDatabase.ts";
import { useBreakpoint } from "../../hooks/useBreakpoint.ts";
import { today } from "../../lib/period.ts";
import { useUndoRedo } from "../shell/historyKeys.ts";
import ActionBar from "./ActionBar.tsx";
import { ColumnMenu } from "./ColumnMenus.tsx";
import { ADD_DESCRIPTION, describeDelete, describeEdit } from "./describe.ts";
import { newTransaction } from "./newTransaction.ts";
import TransactionsList from "./TransactionsList.tsx";
import TransactionsTable, {
  type Added,
  type AddAt,
  type TransactionChange,
} from "./TransactionsTable.tsx";
import { DEFAULT_VIEW, filterValues, viewOrder, type TransactionsView } from "./view.ts";

/** The message of an error a write rejected with. */
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The transactions a view showed, as positions in the rows of the read it was worked out from. */
type Shown = {
  view: TransactionsView;
  read: Transactions["read"];
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
  const canUndo = useSyncExternalStore(history.subscribeToStacks, () => history.canUndo);
  const canRedo = useSyncExternalStore(history.subscribeToStacks, () => history.canRedo);
  const undoOrRedo = useUndoRedo(history);
  // The table's columns fit from md; narrower, the transactions are a list.
  const tableFits = useBreakpoint("md");
  // How the table's header menus sort and filter the transactions.
  const [view, setView] = useState(DEFAULT_VIEW);
  // The transactions the table shows. Worked out again when the view
  // changes, or when the rows are read again, but not when an edit (or an
  // undo of one) changes them: an edited row stays where it is, even if
  // it no longer belongs there, until the view changes, rather than moving
  // away from under the edit. An added row is put beside the one it was
  // added next to, and stays there in the same way.
  const [shown, setShown] = useState<Shown | null>(null);
  // The latest row added, for the table to select.
  const [added, setAdded] = useState<Added | null>(null);

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
  // Edits, adds and their undos keep the rows' positions: only reading them
  // again makes new ones.
  const current =
    shown !== null && shown.view === view && shown.read === loaded.read ? shown : null;
  const order = current?.order ?? viewOrder(loaded.rows, view, names, today());
  if (current === null) setShown({ view, read: loaded.read, order });
  // One removed since (an add undone) keeps its place, for if it comes back.
  const rows = order.flatMap((position) =>
    loaded.removed.has(position) ? [] : [loaded.rows[position]!],
  );
  const transactions = existing(loaded);
  const values = filterValues(transactions, names);

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
          `Couldn't change ${changes.length === 1 ? "that transaction" : "those transactions"}: ${messageOf(error)}`,
        );
      },
    );
  };

  /**
   * Adds a row where the action bar asked (see `AddAt`), showing it beside
   * the row it was added next to, and saying so if it couldn't be added.
   */
  const add = ({ row, side, column }: AddAt) => {
    // As the transactions are now, with an edit settled just before.
    const latest = queryClient.getQueryData(query.queryKey)!;
    const beside = row === null ? null : latest.rows[latest.positions.get(rows[row]!.id)!]!;
    // Above is the newer side, but where the oldest are shown first.
    const oldestFirst = view.sort.column === "date" && view.sort.direction === "ascending";
    const placement: Placement =
      beside === null
        ? { kind: "newest" }
        : {
            kind: "beside",
            id: beside.id,
            side: (side === "above") !== oldestFirst ? "newer" : "older",
          };
    const day = today();
    addTransaction(queryClient, database, history, {
      transaction: newTransaction(beside, {
        accounts: latest.accounts,
        transactions: existing(latest),
        today: day,
      }),
      placement,
      description: ADD_DESCRIPTION,
      today: day,
    }).then(
      (id) => {
        if (id === null) return;
        const { positions, read } = queryClient.getQueryData(query.queryKey)!;
        const position = positions.get(id)!;
        const besidePosition = beside === null ? undefined : positions.get(beside.id);
        setShown((shown) => {
          // Worked out again since, with it.
          if (shown === null || shown.read !== read || shown.order.includes(position)) return shown;
          const at = besidePosition === undefined ? -1 : shown.order.indexOf(besidePosition);
          // With nothing to go beside, first.
          const index = at === -1 ? 0 : side === "above" ? at : at + 1;
          return { ...shown, order: shown.order.toSpliced(index, 0, position) };
        });
        setAdded({ id, column });
      },
      (error: unknown) => {
        toast.error(`Couldn't add a transaction: ${messageOf(error)}`);
      },
    );
  };

  /** Deletes the rows at `indexes`, saying so if they couldn't be deleted. */
  const deleteRows = (indexes: readonly number[]) => {
    // As the transactions are now, with an edit settled just before.
    const latest = queryClient.getQueryData(query.queryKey)!;
    const deleting = indexes.map((index) => latest.rows[latest.positions.get(rows[index]!.id)!]!);
    deleteTransactions(
      queryClient,
      database,
      history,
      deleting.map(({ id }) => id),
      describeDelete(deleting),
    ).catch((error: unknown) => {
      toast.error(
        `Couldn't delete ${deleting.length === 1 ? "that transaction" : "those transactions"}: ${messageOf(error)}`,
      );
    });
  };

  // With an account, there can be transactions to add, even without any yet.
  const showsTable = tableFits && (transactions.length > 0 || loaded.accounts.length > 0);

  return (
    // With the table, the end of the page has room for the action bar
    // floating over it, so the last rows can scroll out from under it.
    <div className={`flex flex-col gap-4 ${showsTable ? "pb-28" : "pb-8"}`}>
      <h1 className="px-4 font-display text-3xl font-bold tracking-tight lg:px-8">Transactions</h1>
      {!showsTable ? (
        transactions.length === 0 ? (
          <p className="px-4 text-ink-muted lg:px-8">No transactions yet.</p>
        ) : (
          <TransactionsList transactions={transactions} accounts={loaded.accounts} />
        )
      ) : (
        <TransactionsTable
          rows={rows}
          // Every transaction, so filtering doesn't move the columns.
          maxRowNumber={transactions.length}
          categories={categories}
          accounts={accounts}
          currencies={currencies}
          onCommit={commit}
          onEditingChange={setEditing}
          lastUndoOrRedo={loaded.lastUndoOrRedo}
          onUndoOrRedo={undoOrRedo}
          lastAdded={added}
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
          actionBar={{
            canUndo,
            canRedo,
            add: loaded.accounts.length > 0 ? add : null,
            deleteRows,
            render: (actions) => <ActionBar {...actions} />,
          }}
        />
      )}
    </div>
  );
}

export default TransactionsPage;
