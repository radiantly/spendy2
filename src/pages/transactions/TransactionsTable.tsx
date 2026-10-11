import { useLayoutEffect, useRef, useState } from "react";
import { useTable } from "@tanstack/react-table";
import { defaultRangeExtractor, useWindowVirtualizer, type Range } from "@tanstack/react-virtual";
import type { TransactionRow } from "../../db/queries/transactions.ts";
import { columns, features, type CellEditor } from "./columns.ts";
import EditableCell, { type SubmitResult } from "./EditableCell.tsx";

/** Rows have a fixed height, so the virtualizer never has to measure them. */
export const ROW_HEIGHT = 28;

const GRID_TEMPLATE = columns.map((column) => column.meta!.track).join(" ");

type Editing = { rowIndex: number; columnId: string; caret: number };

type TransactionsTableProps = {
  rows: TransactionRow[];
  categories: ReadonlySet<string>;
  onCommit: (rowIndex: number, field: CellEditor["field"], value: string | number | null) => void;
};

/**
 * Every transaction on one long page. Only the rows in (and near) the
 * viewport are rendered; the page scrolls as if all of them were there.
 */
function TransactionsTable({ rows, categories, onCommit }: TransactionsTableProps) {
  // The table and virtualizer are mutable objects that return new results
  // from the same instance, so the React Compiler would memoize reads of
  // them and render stale rows. They are only read here, so opting this
  // component out keeps the rest of the app compiled.
  "use no memo";

  const table = useTable({ features, columns, data: rows });
  const tableRows = table.getRowModel().rows;
  const [editing, setEditing] = useState<Editing | null>(null);

  // The virtualizer measures scroll positions from the top of the page; it
  // needs to know where the rows start.
  const bodyRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    setScrollMargin(bodyRef.current!.getBoundingClientRect().top + window.scrollY);
  }, []);

  const virtualizer = useWindowVirtualizer({
    count: tableRows.length,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    scrollMargin,
    // Keep the row being edited rendered when it scrolls out of view, so its
    // input (and the edit in it) isn't thrown away.
    rangeExtractor: (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      if (editing && !indexes.includes(editing.rowIndex)) indexes.push(editing.rowIndex);
      return indexes;
    },
  });

  function submit(
    row: TransactionRow,
    rowIndex: number,
    editor: CellEditor,
    text: string,
  ): SubmitResult {
    // Unchanged text is never parsed, so a stored value the parser wouldn't
    // accept can still be left as it is.
    if (text === editor.editText(row)) return { ok: true };
    const result = editor.parse(text, { categories });
    if (!result.ok) return result;
    // Typed differently but the same value, like `1234.5` for `1234.50`.
    if (result.value === row[editor.field]) return { ok: true };
    onCommit(rowIndex, editor.field, result.value);
    return { ok: true };
  }

  return (
    <div role="table" aria-rowcount={tableRows.length + 1} className="text-sm">
      <div role="rowgroup" className="sticky top-0 z-20 bg-canvas">
        {table.getHeaderGroups().map((group) => (
          <div
            key={group.id}
            role="row"
            aria-rowindex={1}
            className="grid border-y border-line"
            style={{ gridTemplateColumns: GRID_TEMPLATE, height: ROW_HEIGHT }}
          >
            {group.headers.map((header) => (
              <div
                key={header.id}
                role="columnheader"
                className={`flex items-center truncate border-r border-line px-2 font-mono text-xs tracking-widest text-ink-muted uppercase last:border-r-0 ${
                  header.column.columnDef.meta!.align === "end" ? "justify-end" : ""
                }`}
              >
                <table.FlexRender header={header} />
              </div>
            ))}
          </div>
        ))}
      </div>

      <div
        ref={bodyRef}
        role="rowgroup"
        className="relative"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const row = tableRows[item.index]!;
          const isEditingRow = editing?.rowIndex === item.index;
          return (
            <div
              key={row.id}
              role="row"
              aria-rowindex={item.index + 2}
              className={`absolute inset-x-0 top-0 grid leading-7 ${isEditingRow ? "z-10" : ""}`}
              style={{
                gridTemplateColumns: GRID_TEMPLATE,
                height: ROW_HEIGHT,
                transform: `translateY(${item.start - scrollMargin}px)`,
              }}
            >
              {row.getAllCells().map((cell) => {
                const meta = cell.column.columnDef.meta!;
                const editor = meta.editor;
                const caret =
                  isEditingRow && editing.columnId === cell.column.id ? editing.caret : null;
                return (
                  <EditableCell
                    key={cell.id}
                    display={meta.display(row.original)}
                    align={meta.align}
                    mono={meta.mono}
                    edit={
                      editor && {
                        text: editor.editText(row.original),
                        caret,
                        start: (offset) =>
                          setEditing({
                            rowIndex: item.index,
                            columnId: cell.column.id,
                            caret: offset,
                          }),
                        // row.index is the position in `rows`, item.index in the rendered order.
                        submit: (text) => submit(row.original, row.index, editor, text),
                        // Only if still editing this cell: clicking another cell finishes
                        // this one after the other has started.
                        finish: () =>
                          setEditing((current) =>
                            current?.rowIndex === item.index && current.columnId === cell.column.id
                              ? null
                              : current,
                          ),
                      }
                    }
                  />
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default TransactionsTable;
