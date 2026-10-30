import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  TbArrowBackUp,
  TbArrowForwardUp,
  TbArrowsLeftRight,
  TbCheck,
  TbFileIsr,
  TbRowInsertBottom,
  TbRowInsertTop,
  TbSearch,
  TbTrash,
  TbX,
} from "react-icons/tb";
import type { MarkKind } from "./marks.ts";

/**
 * While the selected rows are being marked as `kind`, and the row to mark
 * them against is picked: `picked` is that row's number (null while none
 * is), and `mark` marks them against it (null while that would change
 * nothing). `cancel` stops.
 */
export type PickingActions = {
  kind: MarkKind;
  picked: { row: number; mark: (() => void) | null } | null;
  cancel: () => void;
};

/**
 * What the bar's buttons do to the table (see TransactionsTable's
 * `actionBar`): each null while it can't be done. Marking as a duplicate or
 * a transfer starts `picking` the row to mark against. While the selected
 * rows are all marked as one already, its button unmarks them instead.
 */
export type TableActions = {
  undo: (() => void) | null;
  redo: (() => void) | null;
  addAbove: (() => void) | null;
  addBelow: (() => void) | null;
  deleteRows: (() => void) | null;
  markDuplicate: (() => void) | null;
  markTransfer: (() => void) | null;
  unmarkDuplicate: (() => void) | null;
  unmarkTransfer: (() => void) | null;
  picking: PickingActions | null;
};

/** How long the pointer rests on a button before its tooltip shows (ms). */
const TOOLTIP_DELAY = 500;
/** How soon after a tooltip hides the next shows without the wait (ms). */
const TOOLTIP_SKIP_DELAY = 300;

/**
 * Which of a set of buttons shows its tooltip: one at a time, after the
 * pointer rests on it a moment, or at once on keyboard focus. Once one has
 * shown, moving straight on to another shows that one at once, as tooltips
 * do, until the pointer has been off them for a moment. `swapped` is set
 * for one shown straight on from another, which takes its place at once
 * rather than fading in.
 */
function useTooltips() {
  const [shown, setShown] = useState<{ id: string; swapped: boolean } | null>(null);
  const timerRef = useRef(0);
  // Whether a tooltip has just shown, so the next one needn't wait.
  const warmRef = useRef(false);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  function showNow(id: string) {
    clearTimeout(timerRef.current);
    setShown({ id, swapped: warmRef.current });
    warmRef.current = true;
  }

  return {
    shown,
    showNow,
    hover(id: string) {
      clearTimeout(timerRef.current);
      if (warmRef.current) showNow(id);
      else timerRef.current = window.setTimeout(() => showNow(id), TOOLTIP_DELAY);
    },
    hide() {
      clearTimeout(timerRef.current);
      setShown(null);
      timerRef.current = window.setTimeout(() => {
        warmRef.current = false;
      }, TOOLTIP_SKIP_DELAY);
    },
  };
}

type Tooltips = ReturnType<typeof useTooltips>;

/**
 * A button that's just an icon, named by its tooltip (see `useTooltips`).
 * Pressing it keeps focus where it was, so the grid's selection and keys
 * carry on. `action` is what pressing it does; while it's null, the button
 * is disabled, but keeps its tooltip, and focus.
 */
function IconButton({
  label,
  action,
  tooltips,
  children,
}: {
  label: string;
  action?: (() => void) | null;
  tooltips: Tooltips;
  children: ReactNode;
}) {
  const tooltipId = useId();
  const { shown } = tooltips;
  const open = shown?.id === tooltipId;
  // It fades in and out, but not when one takes another's place.
  const fades = open ? !shown.swapped : shown === null;
  const disabled = action === null;
  return (
    <span className="relative">
      <button
        type="button"
        aria-labelledby={tooltipId}
        aria-disabled={disabled || undefined}
        onClick={action ?? undefined}
        onMouseDown={(event) => event.preventDefault()}
        // Not for touch, where there's no hovering.
        onPointerEnter={(event) => event.pointerType === "mouse" && tooltips.hover(tooltipId)}
        onPointerLeave={tooltips.hide}
        onFocus={(event) =>
          event.currentTarget.matches(":focus-visible") && tooltips.showNow(tooltipId)
        }
        onBlur={tooltips.hide}
        className={`grid size-9 place-items-center rounded-full text-xl text-ink-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus ${
          disabled ? "opacity-60" : "hover:bg-field hover:text-ink"
        }`}
      >
        {children}
      </button>
      <span
        id={tooltipId}
        role="tooltip"
        className={`pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 rounded-md bg-ink px-2 py-1 text-xs font-medium whitespace-nowrap text-canvas ${
          open ? "opacity-100" : "invisible opacity-0"
        } ${fades ? "transition-[opacity,visibility] duration-150" : ""}`}
      >
        {label}
      </span>
    </span>
  );
}

/** The gap a slash cuts through an icon (see `Slashed`), along its diagonal. */
const SLASH_GAP =
  "linear-gradient(to top right, #000 calc(50% - 0.12em), transparent calc(50% - 0.12em) calc(50% + 0.12em), #000 calc(50% + 0.12em))";

/**
 * An icon, struck through while `slashed`, for a button that undoes what
 * the icon does. As Tabler's "off" icons are, the slash cuts a gap through
 * the icon, so it reads on any background.
 */
function Slashed({ slashed, children }: { slashed: boolean; children: ReactNode }) {
  return (
    <span className="relative grid">
      <span className="grid" style={slashed ? { maskImage: SLASH_GAP } : undefined}>
        {children}
      </span>
      {slashed && (
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          className="absolute inset-0 size-full"
        >
          <path d="M3 3l18 18" />
        </svg>
      )}
    </span>
  );
}

function Divider() {
  return <span aria-hidden className="mx-1 h-5 w-px bg-line" />;
}

/**
 * What the confirm button's tooltip says: what it marks, and against which
 * row once one is picked, though that would change nothing.
 */
function confirmLabel({ kind, picked }: PickingActions) {
  if (kind === "duplicate")
    return picked ? `Mark as duplicate of row ${picked.row}` : "Mark as duplicate";
  return picked ? `Mark as transfer with row ${picked.row}` : "Mark as transfer";
}

/**
 * A pill floating at the bottom of the window, over the table: a search of
 * the transactions, undo and redo, and actions on the selected rows. Marking
 * as a duplicate or a transfer turns those two buttons into cancel and
 * confirm while the row to mark against is picked. All but the search are
 * wired up so far.
 */
function ActionBar({
  undo,
  redo,
  addAbove,
  addBelow,
  deleteRows,
  markDuplicate,
  markTransfer,
  unmarkDuplicate,
  unmarkTransfer,
  picking,
}: TableActions) {
  const tooltips = useTooltips();
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-30 flex justify-center px-4">
      {/* As tall as the header's tabs. */}
      <div className="pointer-events-auto flex items-center rounded-full border border-line bg-surface p-1 shadow-lg">
        <search className="flex h-9 w-64 items-center gap-2 rounded-full bg-field px-3 focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-focus">
          <TbSearch aria-hidden className="shrink-0 text-ink-muted" />
          <input
            type="search"
            aria-label="Search transactions"
            placeholder="Search transactions"
            className="min-w-0 grow bg-transparent text-sm outline-none placeholder:text-ink-muted"
          />
        </search>
        <Divider />
        <IconButton label="Undo" action={undo} tooltips={tooltips}>
          <TbArrowBackUp />
        </IconButton>
        <IconButton label="Redo" action={redo} tooltips={tooltips}>
          <TbArrowForwardUp />
        </IconButton>
        <Divider />
        <IconButton label="Add row above" action={addAbove} tooltips={tooltips}>
          <TbRowInsertTop />
        </IconButton>
        <IconButton label="Add row below" action={addBelow} tooltips={tooltips}>
          <TbRowInsertBottom />
        </IconButton>
        <IconButton label="Delete selected rows" action={deleteRows} tooltips={tooltips}>
          <TbTrash />
        </IconButton>
        <Divider />
        {/* In the same places, so a tooltip shown stays on its button. */}
        {picking ? (
          <>
            <IconButton
              label={`Cancel marking as ${picking.kind}`}
              action={picking.cancel}
              tooltips={tooltips}
            >
              <TbX />
            </IconButton>
            <IconButton
              label={confirmLabel(picking)}
              action={picking.picked?.mark ?? null}
              tooltips={tooltips}
            >
              <TbCheck />
            </IconButton>
          </>
        ) : (
          <>
            <IconButton
              label={unmarkDuplicate ? "Unmark as duplicate" : "Mark as duplicate"}
              action={unmarkDuplicate ?? markDuplicate}
              tooltips={tooltips}
            >
              <Slashed slashed={unmarkDuplicate !== null}>
                <TbFileIsr />
              </Slashed>
            </IconButton>
            <IconButton
              label={unmarkTransfer ? "Unmark as transfer" : "Mark as transfer"}
              action={unmarkTransfer ?? markTransfer}
              tooltips={tooltips}
            >
              <Slashed slashed={unmarkTransfer !== null}>
                <TbArrowsLeftRight />
              </Slashed>
            </IconButton>
          </>
        )}
      </div>
    </div>
  );
}

export default ActionBar;
