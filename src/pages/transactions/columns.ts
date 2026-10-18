import { createColumnHelper, tableFeatures } from "@tanstack/react-table";
import type {
  EditableTransactionField,
  TransactionPatch,
  TransactionRow,
} from "../../db/queries/transactions.ts";
import {
  amountEditText,
  formatAmountValue,
  mapResult,
  parseAccount,
  parseAmount,
  parseCategory,
  parseCounterparty,
  parseNaiveDate,
  parseRemarks,
  type ParseResult,
} from "./fields.ts";
import type { MenuConfig } from "./menu.ts";
import type { MenuColumn } from "./view.ts";

/**
 * What a cell shows. `prefix` is shown but not edited, like the currency in
 * `USD 10.00`.
 */
export type CellDisplay = { prefix?: string; text: string };

export type CellEditor = {
  field: EditableTransactionField;
  /** The text the input starts with. */
  editText: (row: TransactionRow) => string;
  /**
   * The columns to store for the text typed into `row`'s cell, or why it
   * can't be. `create` is set when the user picked the menu's create item.
   */
  parse: (
    text: string,
    row: TransactionRow,
    context: EditContext & { create: boolean },
  ) => ParseResult<TransactionPatch>;
  /** Makes the cell a combobox: an input with a menu of options. */
  menu?: (context: EditContext) => MenuConfig;
};

/** Data the editors need from outside the row. */
export type EditContext = { categories: readonly string[]; accounts: readonly string[] };

export type TransactionColumnMeta = {
  /** The column's CSS grid track. */
  track: string;
  align?: "end";
  /** For numbers, so digits line up. */
  mono?: boolean;
  display: (row: TransactionRow) => CellDisplay;
  /** Absent for read-only columns. */
  editor?: CellEditor;
  /** For a column the transactions can be sorted or filtered by: its header's menu. */
  headerMenu?: MenuColumn;
};

export const features = tableFeatures({ columnMeta: {} as TransactionColumnMeta });

const helper = createColumnHelper<typeof features, TransactionRow>();

export const columns = helper.columns([
  helper.accessor("naive_date", {
    header: "Date",
    meta: {
      track: "minmax(6.5rem, 7rem)",
      mono: true,
      headerMenu: "date",
      display: (row) => ({ text: row.naive_date }),
      editor: {
        field: "naive_date",
        editText: (row) => row.naive_date,
        parse: (text) => mapResult(parseNaiveDate(text), (naive_date) => ({ naive_date })),
      },
    },
  }),
  helper.accessor("account_name", {
    header: "Account",
    meta: {
      track: "minmax(7rem, 1.2fr)",
      headerMenu: "account",
      display: (row) => ({ text: row.account_name }),
      editor: {
        field: "account_name",
        editText: (row) => row.account_name,
        parse: (text, _row, { accounts }) =>
          mapResult(parseAccount(text, accounts), (account_name) => ({ account_name })),
        menu: ({ accounts }) => ({ options: accounts, noMatch: "No account found" }),
      },
    },
  }),
  helper.accessor("counterparty", {
    header: "Counterparty",
    meta: {
      track: "minmax(8rem, 2fr)",
      headerMenu: "counterparty",
      display: (row) => ({ text: row.counterparty }),
      editor: {
        field: "counterparty",
        editText: (row) => row.counterparty,
        parse: (text) => mapResult(parseCounterparty(text), (counterparty) => ({ counterparty })),
      },
    },
  }),
  helper.accessor("category", {
    header: "Category",
    meta: {
      track: "minmax(7rem, 1.2fr)",
      headerMenu: "category",
      display: (row) => ({ text: row.category ?? "" }),
      editor: {
        field: "category",
        editText: (row) => row.category ?? "",
        parse: (text, _row, { categories, create }) =>
          mapResult(parseCategory(text, categories, create), (category) => ({ category })),
        menu: ({ categories }) => ({
          options: categories,
          createLabel: (name) => `Create category “${name}”`,
          noMatch: "No category found",
        }),
      },
    },
  }),
  helper.display({
    id: "amount",
    header: "Amount",
    meta: {
      track: "minmax(8rem, 1fr)",
      align: "end",
      mono: true,
      headerMenu: "amount",
      display: (row) => ({
        prefix: `${row.currency} `,
        text: formatAmountValue(row, row.currency),
      }),
      editor: {
        field: "amount",
        // Without the currency, so only the number is edited.
        editText: (row) => amountEditText(row),
        parse: (text, row) => mapResult(parseAmount(text, row.decimals), (amount) => ({ amount })),
      },
    },
  }),
  helper.accessor("remarks", {
    header: "Remarks",
    meta: {
      track: "minmax(8rem, 2.5fr)",
      display: (row) => ({ text: row.remarks ?? "" }),
      editor: {
        field: "remarks",
        editText: (row) => row.remarks ?? "",
        parse: (text) => mapResult(parseRemarks(text), (remarks) => ({ remarks })),
      },
    },
  }),
]);
