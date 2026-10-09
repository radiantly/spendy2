import { useId, type InputHTMLAttributes, type ReactNode } from "react";

type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  label: string;
  /** Shown below the input. Replaced by `error` when one is set. */
  hint?: ReactNode;
  error?: string;
  /**
   * Marks the field invalid without showing an error message, for when the
   * hint itself conveys the problem. Implied by `error`.
   */
  invalid?: boolean;
  /** Rendered inside the input, aligned to the right (e.g. a visibility toggle). */
  trailing?: ReactNode;
};

function TextField({
  label,
  hint,
  error,
  invalid = error !== undefined,
  trailing,
  ...inputProps
}: TextFieldProps) {
  const id = useId();
  const messageId = `${id}-message`;
  const message = error ?? hint;

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="font-mono text-xs tracking-widest text-ink-muted uppercase">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          aria-invalid={invalid || undefined}
          aria-describedby={message ? messageId : undefined}
          className={`w-full rounded-xl border bg-field px-4 py-3 text-base text-ink transition-[border-color] placeholder:text-ink-muted/70 focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-focus disabled:opacity-60 ${
            invalid ? "border-danger" : "border-line"
          } ${trailing ? "pr-12" : ""}`}
          {...inputProps}
        />
        {trailing && (
          <div className="absolute inset-y-0 right-0 flex items-center pr-2">{trailing}</div>
        )}
      </div>
      {message && (
        <div id={messageId} className={`text-sm ${error ? "text-danger" : "text-ink-muted"}`}>
          {message}
        </div>
      )}
    </div>
  );
}

export default TextField;
