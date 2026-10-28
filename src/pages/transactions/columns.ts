import { createColumnHelper, tableFeatures } from "@tanstack/react-table";
import type {
  Currency,
  EditableTransactionField,
  TransactionPatch,
  TransactionRow,
} from "../../db/queries/transactions.ts";
import { formatMoney, roundsToZero } from "../../lib/money.ts";
import {
  amountEditText,
  mapResult,
  parseAccount,
  parseAmount,
  parseCategory,
  parseCounterparty,
  parseCurrency,
  parseNaiveDate,
  parseRemarks,
  type ParseResult,
} from "./fields.ts";
import type { MenuConfig } from "./menu.ts";
import type { MenuColumn } from "./view.ts";

export type CellEditor = {
  field: EditableTransactionField;
  /** The text the input starts with. */
  editText: (row: TransactionRow) => string;
  /**
   * Gives the edit a prefix before the text, in an input of its own, like
   * the currency in `USD 10.00` (see prefix.ts): the prefix an edit starts
   * with, and the input's label.
   */
  prefix?: { editText: (row: TransactionRow) => string; label: string };
  /**
   * The columns to store for the text typed into `row`'s cell, or why it
   * can't be. `create` is set when the user picked the menu's create item.
   * `prefix` is the prefix as edited; without it, the cell's own is kept.
   */
  parse: (
    text: string,
    row: TransactionRow,
    context: EditContext & { create: boolean; prefix?: string },
  ) => ParseResult<TransactionPatch>;
  /** Makes the cell a combobox: an input with a menu of options. */
  menu?: (context: EditContext) => MenuConfig;
};

/** Data the editors need from outside the row. */
export type EditContext = {
  categories: readonly string[];
  accounts: readonly string[];
  currencies: readonly Currency[];
};

/**
 * `row`'s amount as typed, in the currency whose code is `code`, or the
 * row's own if there's none (or it's empty). The row's own currency keeps
 * the decimals its amount is stored with.
 */
function parseAmountIn(
  text: string,
  code: string | undefined,
  row: TransactionRow,
  currencies: readonly Currency[],
): ParseResult<TransactionPatch> {
  let currency: Currency = { code: row.currency, stored_decimals: row.decimals };
  if (code !== undefined && code.trim() !== "") {
    const parsed = parseCurrency(code, currencies);
    if (!parsed.ok) return parsed;
    if (parsed.value.code !== row.currency) currency = parsed.value;
  }
  return mapResult(parseAmount(text, currency.stored_decimals), (amount) => ({
    currency: currency.code,
    amount,
    decimals: currency.stored_decimals,
  }));
}

export type TransactionColumnMeta = {
  /** The column's CSS grid track. */
  track: string;
  align?: "end";
  /** For numbers: tabular figures, so digits line up. */
  tabular?: boolean;
  /** What the cell shows. */
  display: (row: TransactionRow) => string;
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
      tabular: true,
      headerMenu: "date",
      display: (row) => row.naive_date,
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
      display: (row) => row.account_name,
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
      display: (row) => row.counterparty,
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
      display: (row) => row.category ?? "",
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
      tabular: true,
      headerMenu: "amount",
      // Zero shows as nothing, like any cleared cell: clearing an amount stores 0.
      display: (row) =>
        roundsToZero(row, row.currency) ? "" : formatMoney(row, row.currency, { sign: "in" }),
      editor: {
        field: "amount",
        // The number; the currency is the prefix.
        editText: (row) => amountEditText(row),
        prefix: { editText: (row) => row.currency, label: "Currency" },
        parse: (text, row, { currencies, prefix }) => parseAmountIn(text, prefix, row, currencies),
      },
    },
  }),
  helper.accessor("remarks", {
    header: "Remarks",
    meta: {
      track: "minmax(8rem, 2.5fr)",
      display: (row) => row.remarks ?? "",
      editor: {
        field: "remarks",
        editText: (row) => row.remarks ?? "",
        parse: (text) => mapResult(parseRemarks(text), (remarks) => ({ remarks })),
      },
    },
  }),
]);
