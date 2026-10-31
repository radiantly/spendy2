/*
 * The page and the parts of the transactions' table that its loader (see
 * TransactionsLoader) draws too, so the loader is laid out as the table is,
 * and the table appears where it was. They're only how the parts look: the
 * table gives them their roles and what they do, passed on to the element
 * each one is.
 */

import type { ComponentProps, ReactNode } from "react";
import { HEADER_HEIGHT, ROW_HEIGHT } from "./tableLayout.ts";

type DivProps = ComponentProps<"div">;

/**
 * The transactions' page: its heading, then `children`. With the table,
 * its end has room for the action bar floating over it, so the last rows
 * can scroll out from under it.
 */
export function TransactionsFrame({
  withTable,
  children,
}: {
  withTable: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`flex flex-col gap-4 ${withTable ? "pb-28" : "pb-8"}`}>
      <h1 className="px-4 font-display text-3xl font-bold tracking-tight lg:px-8">Transactions</h1>
      {children}
    </div>
  );
}

/** The table, its header and its rows. */
export function TableFrame({ className = "", ...props }: DivProps) {
  return <div {...props} className={`cursor-default text-sm ${className}`} />;
}

/** Holds the header's row, at the top of the window over the rows as they scroll. */
export function TableHeader({ className = "", ...props }: DivProps) {
  return <div {...props} className={`sticky top-0 z-20 bg-canvas ${className}`} />;
}

/** The header's row, its cells in the tracks of `template` (see gridTemplate). */
export function HeaderRow({ template, className = "", ...props }: DivProps & { template: string }) {
  return (
    <div
      {...props}
      className={`grid border-y border-line ${className}`}
      style={{ gridTemplateColumns: template, height: HEADER_HEIGHT }}
    />
  );
}

/** The header's first cell, over the row numbers. */
export function CornerCell({ className = "", ...props }: DivProps) {
  return (
    <div
      {...props}
      className={`flex items-center border-r border-line text-ink-muted ${className}`}
    />
  );
}

/** A column's header cell. */
export function HeaderCell({ className = "", ...props }: DivProps) {
  return (
    <div
      {...props}
      className={`flex items-center truncate border-r border-line font-medium text-ink-muted last:border-r-0 ${className}`}
    />
  );
}

/** A row, its cells in the tracks of `template` (see gridTemplate). */
export function TableRow({
  template,
  className = "",
  style,
  ...props
}: DivProps & { template: string }) {
  return (
    <div
      {...props}
      className={`grid leading-7 ${className}`}
      style={{ gridTemplateColumns: template, height: ROW_HEIGHT, ...style }}
    />
  );
}

/** A row's number, its first cell. */
export function RowNumberCell({ className = "", ...props }: DivProps) {
  return (
    <div
      {...props}
      className={`truncate border-r border-b border-line px-2 text-right text-ink-muted tabular-nums ${className}`}
    />
  );
}

/** A cell of a column, aligned as the column's are, with tabular figures for numbers. */
export function Cell({
  align,
  tabular,
  className = "",
  ...props
}: DivProps & { align?: "end"; tabular?: boolean }) {
  return (
    <div
      {...props}
      className={`min-w-0 border-r border-b border-line px-2 last:border-r-0 ${
        align === "end" ? "text-right" : ""
      } ${tabular ? "tabular-nums" : ""} ${className}`}
    />
  );
}
