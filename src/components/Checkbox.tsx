import { useId, useLayoutEffect, useRef, type InputHTMLAttributes } from "react";
import { FiCheck, FiMinus } from "react-icons/fi";

type CheckboxBoxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  /** Shows the box partly checked (a dash), e.g. for one that checks several others. */
  indeterminate?: boolean;
};

/**
 * A native checkbox drawn by us (`appearance-none`) so its hover and checked
 * states can transition like the rest of the form. The input is still the
 * real control, so keyboard, forms and assistive tech work as usual. Just the
 * box: for controls that lay out their own label (see Checkbox).
 */
export function CheckboxBox({ indeterminate = false, ...inputProps }: CheckboxBoxProps) {
  const ref = useRef<HTMLInputElement>(null);
  // Only a property, and clicking the input clears it, so it's set after every render.
  useLayoutEffect(() => {
    ref.current!.indeterminate = indeterminate;
  });

  return (
    <span className="relative grid size-4 shrink-0 place-items-center">
      <input
        ref={ref}
        type="checkbox"
        // Not `transition-colors`: it would also animate the focus outline's colour.
        className="peer size-4 cursor-pointer appearance-none rounded border border-line bg-field transition-[background-color,border-color,filter] checked:border-lime checked:bg-lime indeterminate:border-lime indeterminate:bg-lime focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-focus enabled:hover:brightness-95 disabled:cursor-not-allowed"
        {...inputProps}
      />
      <FiCheck
        aria-hidden
        className="pointer-events-none absolute stroke-[3.5] text-xs text-ink-on-lime opacity-0 transition-opacity peer-checked:opacity-100 peer-indeterminate:opacity-0"
      />
      <FiMinus
        aria-hidden
        className="pointer-events-none absolute stroke-[3.5] text-xs text-ink-on-lime opacity-0 transition-opacity peer-indeterminate:opacity-100"
      />
    </span>
  );
}

type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "type"> & {
  label: string;
};

/** A checkbox with its label after it. */
function Checkbox({ label, ...inputProps }: CheckboxProps) {
  const id = useId();

  return (
    <div className="flex items-center gap-3 transition-opacity has-disabled:opacity-60">
      <CheckboxBox id={id} {...inputProps} />
      <label htmlFor={id} className="text-sm text-ink">
        {label}
      </label>
    </div>
  );
}

export default Checkbox;
