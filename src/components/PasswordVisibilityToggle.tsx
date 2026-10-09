import { FaEye, FaEyeSlash } from "react-icons/fa6";

type PasswordVisibilityToggleProps = {
  visible: boolean;
  onToggle: () => void;
  disabled?: boolean;
};

/** Meant for TextField's `trailing` slot. */
function PasswordVisibilityToggle({ visible, onToggle, disabled }: PasswordVisibilityToggleProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-label={visible ? "Hide password" : "Show password"}
      aria-pressed={visible}
      className="grid size-9 place-items-center rounded-lg text-ink-muted transition outline-none focus-visible:ring-3 focus-visible:ring-focus enabled:hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
    >
      {visible ? <FaEyeSlash aria-hidden /> : <FaEye aria-hidden />}
    </button>
  );
}

export default PasswordVisibilityToggle;
