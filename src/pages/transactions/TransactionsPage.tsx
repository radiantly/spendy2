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
  markTransactions,
  transactionsQuery,
  type Placement,
  type Transactions,
} from "../../db/transactions.ts";
import { useOpenDatabase } from "../../db/useDatabase.ts";
import { useBreakpoint } from "../../hooks/useBreakpoint.ts";
import { download } from "../../lib/download.ts";
import { today } from "../../lib/period.ts";
import { useRates } from "../../lib/rates/load.ts";
import { chunksFor } from "../../lib/rates/rates.ts";
import { useUndoRedo } from "../shell/historyKeys.ts";
import ActionBar from "./ActionBar.tsx";
import { ColumnMenu, TableMenu } from "./ColumnMenus.tsx";
import { transactionsCsv } from "./csv.ts";
import { displayAmounts, displayCurrencies } from "./displayAmount.ts";
import {
  ADD_DESCRIPTION,
  describeDelete,
  describeEdit,
  describeMark,
  describeUnmark,
} from "./describe.ts";
import { duplicateMarks, transferMarks, unmarks, type MarkKind } from "./marks.ts";
import { newTransaction } from "./newTransaction.ts";
import { TransactionsFrame } from "./TableParts.tsx";
import TransactionsList from "./TransactionsList.tsx";
import TransactionsLoader from "./TransactionsLoader.tsx";
import TransactionsTable, {
  type Added,
  type AddAt,
  type TransactionChange,
} from "./TransactionsTable.tsx";
import {
  DEFAULT_VIEW,
  filterValues,
  shownRows,
  sortOrder,
  viewHidden,
  withArrived,
  withHidden,
  type Hidden,
  type TransactionsView,
} from "./view.ts";

/** The message of an error a write rejected with. */
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * What a view showed of the rows of the read it was worked out from, by
 * their positions: `order` is every row as the view sorted them, and
 * `hidden` those of them it hid. The first `arrived` of the rows that came
 * in from elsewhere since (see `Transactions`) are placed among them.
 */
type Shown = {
  view: TransactionsView;
  read: Transactions["read"];
  order: number[];
  hidden: Hidden;
  arrived: number;
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
  // The exchange rates the transactions could need, to sort amounts in
  // different currencies by. Nothing waits for them, or minds if they never
  // come: a sort makes do with the ones there are when it's set, and stays
  // as it is when more arrive, as it does when a row is edited.
  const rates = useRates(loaded ? chunksFor(loaded.rows, displayCurrencies(loaded.accounts)) : []);
  const canUndo = useSyncExternalStore(history.subscribeToStacks, () => history.canUndo);
  const canRedo = useSyncExternalStore(history.subscribeToStacks, () => history.canRedo);
  const undoOrRedo = useUndoRedo(history);
  // The table's columns fit from md; narrower, the transactions are a list.
  const tableFits = useBreakpoint("md");
  // How the table's header menus sort and filter the transactions.
  const [view, setView] = useState(DEFAULT_VIEW);
  // The transactions the table shows. Their order is worked out again when
  // the view's sort is set, or when the rows are read again, and which of
  // them are hidden when the view changes at all, but neither when an edit
  // (or an undo of one) changes them: an edited row stays where it is, even
  // if it no longer belongs there, rather than moving away from under the
  // edit. An added row is put beside the one it was added next to, and
  // stays there in the same way. Rows that come in from elsewhere are put
  // where the view would, among the rest. Filtering never moves a row, so
  // the rows keep their numbers through it (see `shownRows`).
  const [shown, setShown] = useState<Shown | null>(null);
  // The latest row added, for the table to select.
  const [added, setAdded] = useState<Added | null>(null);

  if (isError)
    return (
      <p role="alert" className="m-auto text-ink">
        Couldn't load your transactions.
      </p>
    );

  if (loaded === undefined) return <TransactionsLoader message="Loading transactions…" />;

  const accounts = loaded.accounts.map(({ name }) => name);
  const categories = loaded.categories.map(({ name }) => name);
  const names = { accounts, categories };
  const { currencies } = loaded;
  // Each transaction's amount in the currency its account displays in: by
  // the exchange rates where no conversion is stored, once they've arrived.
  const displayAmountOf = displayAmounts(loaded.accounts, currencies, rates);
  // Edits, adds and their undos keep the rows' positions: only reading them
  // again makes new ones.
  let current = shown;
  // Setting the sort makes a new one, even the one it was: that sorts again.
  if (current === null || current.read !== loaded.read || current.view.sort !== view.sort) {
    current = {
      view,
      read: loaded.read,
      order: sortOrder(loaded.rows, view.sort, names, rates),
      hidden: viewHidden(loaded.rows, view, names, today()),
      arrived: loaded.arrived.length,
    };
  } else if (current.view !== view || current.arrived < loaded.arrived.length) {
    const arrived = loaded.arrived.slice(current.arrived).filter((at) => !loaded.removed.has(at));
    current = {
      ...current,
      view,
      order: withArrived(current.order, arrived, loaded.rows, view.sort, names, rates),
      hidden:
        current.view === view
          ? withHidden(current.hidden, arrived, loaded.rows, view, names, today())
          : viewHidden(loaded.rows, view, names, today()),
      arrived: loaded.arrived.length,
    };
  }
  if (current !== shown) setShown(current);
  // One removed since (an add undone) keeps its place, for if it comes back.
  const { rows, numbers } = shownRows(loaded.rows, current.order, current.hidden, loaded.removed);
  const transactions = existing(loaded);
  const values = filterValues(transactions, names);

  /** The transaction with `id`, as it's been read or changed since. */
  const transactionOf = (id: string) => loaded.rows[loaded.positions.get(id)!]!;

  /** Whether the transaction with `id` is still there: not deleted since it was read. */
  const exists = (id: string) => {
    const position = loaded.positions.get(id);
    return position !== undefined && !loaded.removed.has(position);
  };

  /** Stores the changes, saying so if they couldn't be (see `commitTransactions`). */
  const commit = (changes: readonly TransactionChange[]) => {
    if (changes.length === 0) return;
    // Described as the rows are before it.
    const description = describeEdit(changes, transactionOf, { ...names, currencies });
    commitTransactions(queryClient, database, history, changes, description).catch(
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
  const add = ({ id: besideId, side, column }: AddAt) => {
    // As the transactions are now, with an edit settled just before.
    const latest = queryClient.getQueryData(query.queryKey)!;
    const beside = besideId === null ? null : latest.rows[latest.positions.get(besideId)!]!;
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

  /** Deletes the transactions with `ids`, saying so if they couldn't be deleted. */
  const deleteRows = (ids: readonly string[]) => {
    // As the transactions are now, with an edit settled just before.
    const latest = queryClient.getQueryData(query.queryKey)!;
    const deleting = ids.map((id) => latest.rows[latest.positions.get(id)!]!);
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

  /**
   * What marking the transactions `marked` (by id) as `kind` against
   * `picked` does (see marks.ts): stores the marks, saying so if they
   * couldn't be. Null if it would change nothing. While a row is picked, the
   * table asks on every render, so working the marks out is kept quick.
   */
  const mark = (kind: MarkKind, marked: readonly string[], picked: string) => {
    const marks =
      kind === "duplicate"
        ? duplicateMarks(loaded, marked, picked)
        : transferMarks(transactionOf(marked[0]!), transactionOf(picked));
    if (marks.length === 0) return null;
    return () => {
      markTransactions(queryClient, database, history, {
        marks,
        marked,
        description: describeMark(kind, marked.map(transactionOf)),
      }).catch((error: unknown) => {
        toast.error(
          `Couldn't mark ${marked.length === 1 ? "that transaction" : "those transactions"}: ${messageOf(error)}`,
        );
      });
    };
  };

  /** Unmarks the transactions with `ids` as `kind`, saying so if they couldn't be. */
  const unmark = (kind: MarkKind, ids: readonly string[]) => {
    // As the transactions are now, with an edit settled just before.
    const latest = queryClient.getQueryData(query.queryKey)!;
    const unmarking = ids.map((id) => latest.rows[latest.positions.get(id)!]!);
    markTransactions(queryClient, database, history, {
      marks: unmarks(kind, unmarking),
      marked: unmarking.map(({ id }) => id),
      description: describeUnmark(kind, unmarking),
    }).catch((error: unknown) => {
      toast.error(
        `Couldn't unmark ${unmarking.length === 1 ? "that transaction" : "those transactions"}: ${messageOf(error)}`,
      );
    });
  };

  /** Downloads the database as an SQLite file, saying so if it couldn't be. */
  const exportDatabase = () => {
    database.serialize().then(
      (bytes) =>
        download(
          new Blob([bytes], { type: "application/vnd.sqlite3" }),
          `spendy-${today()}.sqlite`,
        ),
      (error: unknown) => {
        toast.error(`Couldn't export the database: ${messageOf(error)}`);
      },
    );
  };

  /** Downloads the transactions shown, in the order they're shown, as CSV. */
  const exportCsv = () => {
    // UTF-8's byte order mark first, or Excel reads the file as the system's own encoding.
    download(
      new Blob(["﻿", transactionsCsv(rows)], { type: "text/csv;charset=utf-8" }),
      `spendy-transactions-${today()}.csv`,
    );
  };

  // With an account, there can be transactions to add, even without any yet.
  const showsTable = tableFits && (transactions.length > 0 || loaded.accounts.length > 0);

  return (
    <TransactionsFrame withTable={showsTable}>
      {!showsTable ? (
        transactions.length === 0 ? (
          <p className="px-4 text-ink-muted lg:px-8">No transactions yet.</p>
        ) : (
          <TransactionsList transactions={transactions} displayAmountOf={displayAmountOf} />
        )
      ) : (
        <TransactionsTable
          rows={rows}
          rowNumbers={numbers}
          // Every transaction, so filtering doesn't move the columns.
          maxRowNumber={transactions.length}
          categories={categories}
          accounts={accounts}
          currencies={currencies}
          // The table's rows are the transactions read, which have their conversions.
          displayAmountOf={(row) => displayAmountOf(loaded.rows[loaded.positions.get(row.id)!]!)}
          onCommit={commit}
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
            corner: (header) => (
              <TableMenu
                header={header}
                view={view}
                onViewChange={setView}
                onExportDatabase={exportDatabase}
                onExportCsv={exportCsv}
              />
            ),
          }}
          actionBar={{
            canUndo,
            canRedo,
            add: loaded.accounts.length > 0 ? add : null,
            deleteRows,
            mark,
            unmark,
            exists,
            render: (actions) => <ActionBar {...actions} />,
          }}
        />
      )}
    </TransactionsFrame>
  );
}

export default TransactionsPage;
