import type { ReactNode } from "react";
import { FiArrowRight, FiLoader } from "react-icons/fi";

type SubmitButtonProps = {
  /** Id of the form to submit, when the button is rendered outside it. */
  form?: string;
  pending: boolean;
  /** Shown with a spinner while `pending`, e.g. "Logging in…". */
  pendingLabel: string;
  children: ReactNode;
};

function SubmitButton({ form, pending, pendingLabel, children }: SubmitButtonProps) {
  return (
    <button
      type="submit"
      form={form}
      disabled={pending}
      className="inline-flex items-center justify-center gap-2 rounded-full bg-lime px-6 py-3.5 font-semibold text-ink-on-lime transition outline-none hover:brightness-95 focus-visible:ring-3 focus-visible:ring-focus focus-visible:ring-offset-3 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-70"
    >
      {pending ? (
        <>
          <FiLoader className="animate-spin" aria-hidden />
          {pendingLabel}
        </>
      ) : (
        <>
          {children}
          <FiArrowRight aria-hidden />
        </>
      )}
    </button>
  );
}

export default SubmitButton;
