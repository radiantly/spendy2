import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import toast from "react-hot-toast";
import type { CellDisplay } from "./columns.ts";
import { mapOffset, textOffsetAtPoint } from "./caret.ts";

/** The outcome of submitting an edit: accepted, or why not. */
export type SubmitResult = { ok: true } | { ok: false; error: string };

type EditableCellProps = {
  display: CellDisplay;
  align?: "end";
  mono?: boolean;
  /** Absent for read-only cells. */
  edit?: {
    /** The text the input starts with. */
    text: string;
    /** Set while this cell is being edited: where the caret starts. */
    caret: number | null;
    start: (caret: number) => void;
    submit: (text: string) => SubmitResult;
    finish: () => void;
  };
};

/**
 * A spreadsheet-style cell: plain text that turns into an input as soon as
 * the mouse goes down on it, with the caret where it was pressed.
 */
function EditableCell({ display, align, mono, edit }: EditableCellProps) {
  const valueRef = useRef<HTMLSpanElement>(null);
  const cellRef = useRef<HTMLDivElement>(null);
  const editing = edit !== undefined && edit.caret !== null;

  function handleMouseDown(event: MouseEvent) {
    if (!edit || editing || event.button !== 0 || !valueRef.current) return;
    // Keep the browser from focusing the cell or selecting text; the input
    // takes focus instead. That also stops focus leaving another cell's
    // input, so blur it here to submit its edit first.
    event.preventDefault();
    if (document.activeElement instanceof HTMLInputElement) document.activeElement.blur();
    const offset = textOffsetAtPoint(valueRef.current, event.clientX, event.clientY);
    edit.start(mapOffset(display.text, offset, edit.text));
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (!edit || editing || event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      edit.start(edit.text.length);
    }
  }

  return (
    <div
      ref={cellRef}
      role="cell"
      tabIndex={edit ? 0 : undefined}
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
      className={`relative min-w-0 border-r border-b border-line px-2 outline-none last:border-r-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus ${
        align === "end" ? "text-right" : ""
      } ${mono ? "font-mono" : ""}`}
    >
      {editing ? (
        <CellInput
          initialText={edit.text}
          caret={edit.caret!}
          align={align}
          submit={edit.submit}
          finish={(refocus) => {
            edit.finish();
            // After Enter or Escape, keep the keyboard on this cell.
            if (refocus) cellRef.current?.focus();
          }}
        />
      ) : (
        <div className="truncate">
          {display.prefix && <span className="text-ink-muted">{display.prefix}</span>}
          <span ref={valueRef}>{display.text}</span>
        </div>
      )}
    </div>
  );
}

type CellInputProps = {
  initialText: string;
  caret: number;
  align?: "end";
  submit: (text: string) => SubmitResult;
  finish: (refocus: boolean) => void;
};

function CellInput({ initialText, caret, align, submit, finish }: CellInputProps) {
  const [text, setText] = useState(initialText);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter and Escape finish the edit themselves; the blur that follows when
  // the input unmounts must not submit again.
  const finishedRef = useRef(false);

  useLayoutEffect(() => {
    const input = inputRef.current!;
    input.focus();
    input.setSelectionRange(caret, caret);
  }, [caret]);

  function done(refocus: boolean) {
    finishedRef.current = true;
    finish(refocus);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      done(true);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const result = submit(text);
      if (result.ok) done(true);
      else setError(result.error);
    }
  }

  function handleBlur() {
    if (finishedRef.current) return;
    const result = submit(text);
    // There's no cell left to show the error on, so say why it was undone.
    if (!result.ok) toast.error(`${result.error}. The change was undone.`);
    done(false);
  }

  return (
    <>
      <input
        ref={inputRef}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setError(null);
        }}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        aria-invalid={error !== null || undefined}
        aria-errormessage={error !== null ? "cell-error" : undefined}
        className={`absolute inset-0 w-full bg-surface px-2 outline-2 -outline-offset-2 ${
          error !== null ? "outline-danger" : "outline-focus"
        } ${align === "end" ? "text-right" : ""}`}
      />
      {error !== null && (
        <div
          id="cell-error"
          role="alert"
          className="absolute top-full left-0 z-10 mt-1 rounded-md bg-danger px-2 py-1 font-sans text-xs whitespace-nowrap text-white"
        >
          {error}
        </div>
      )}
    </>
  );
}

export default EditableCell;
