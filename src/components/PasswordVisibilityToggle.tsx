import { FaEye, FaEyeSlash } from "react-icons/fa6";

type PasswordVisibilityToggleProps = {
  visible: boolean;
  onToggle: () => void;
};

/** Meant for TextField's `trailing` slot. */
function PasswordVisibilityToggle({ visible, onToggle }: PasswordVisibilityToggleProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={visible ? "Hide password" : "Show password"}
      aria-pressed={visible}
      className="grid size-9 place-items-center rounded-lg text-ink-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-focus"
    >
      {visible ? <FaEyeSlash aria-hidden /> : <FaEye aria-hidden />}
    </button>
  );
}

export default PasswordVisibilityToggle;
