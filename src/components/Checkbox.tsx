import { useId, type InputHTMLAttributes } from "react";

type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "type"> & {
  label: string;
};

function Checkbox({ label, ...inputProps }: CheckboxProps) {
  const id = useId();

  return (
    <div className="flex items-center gap-3">
      <input
        id={id}
        type="checkbox"
        className="size-4 shrink-0 accent-lime focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-focus disabled:opacity-60"
        {...inputProps}
      />
      <label htmlFor={id} className="text-sm text-ink">
        {label}
      </label>
    </div>
  );
}

export default Checkbox;
