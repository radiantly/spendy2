import { useState, type SubmitEvent, type TransitionStartFunction } from "react";
import { FaInfoCircle } from "react-icons/fa";
import toast from "react-hot-toast";
import Checkbox from "../../components/Checkbox.tsx";
import TextField from "../../components/TextField.tsx";
import PasswordVisibilityToggle from "../../components/PasswordVisibilityToggle.tsx";
import { useAuth } from "../../auth/useAuth.ts";
import { warnSessionNotSaved } from "./toasts.ts";
import { validateLoginForm, type LoginFormValues, type LoginFormErrors } from "./validate.ts";

// Shared id so repeated failed submits replace the toast instead of stacking.
const LOGIN_ERROR_TOAST = "login-error";

type FormProps = {
  id: string;
  /** Owned by AuthPage, which renders the submit button for this form. */
  pending: boolean;
  startTransition: TransitionStartFunction;
};

/** On success AuthPage redirects away, since the user is now authenticated. */
function LoginForm({ id, pending, startTransition }: FormProps) {
  const { login } = useAuth();
  const [form, setForm] = useState<LoginFormValues>({ username: "", password: "" });
  const [errors, setErrors] = useState<LoginFormErrors>({});
  const [showPassword, setShowPassword] = useState(false);
  const [persist, setPersist] = useState(true);

  function updateField(field: keyof LoginFormValues, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  }

  function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();

    const validationErrors = validateLoginForm(form);
    setErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) return;

    startTransition(async () => {
      try {
        const result = await login(form.username, form.password, { persist });
        if (result.success) {
          if (persist && !result.persisted) warnSessionNotSaved();
          return;
        }

        switch (result.code) {
          case "INVALID_LOGIN":
            setErrors({ password: "Incorrect username or password." });
            break;
          case "RATE_LIMITED":
            toast.error("Too many attempts. Wait a few seconds and try again.", {
              id: LOGIN_ERROR_TOAST,
            });
            break;
          case "LOGIN_FAILED":
            toast.error("Login failed. Please try again.", { id: LOGIN_ERROR_TOAST });
            break;
        }
      } catch {
        toast.error("Couldn't reach the server. Check your connection.", {
          id: LOGIN_ERROR_TOAST,
        });
      }
    });
  }

  return (
    // On desktop, spread across the height reserved by the (taller) register form.
    <form
      id={id}
      onSubmit={handleSubmit}
      noValidate
      className="flex flex-1 flex-col justify-evenly gap-5"
    >
      {/* Desktop only: it fills the space reserved by the register form, and mobile stays minimal. */}
      <p className="hidden gap-3 rounded-xl border border-line bg-field p-4 text-sm text-ink-muted lg:flex lg:items-center">
        <FaInfoCircle className="shrink-0" aria-hidden />
        If you've forgotten your password, your account cannot be recovered.
      </p>
      <TextField
        label="Username"
        name="username"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        value={form.username}
        onChange={(e) => updateField("username", e.target.value)}
        hint="3–32 lowercase letters or numbers"
        error={errors.username}
        disabled={pending}
      />
      <TextField
        label="Password"
        name="password"
        type={showPassword ? "text" : "password"}
        autoComplete="current-password"
        value={form.password}
        onChange={(e) => updateField("password", e.target.value)}
        hint="Enter your strong password"
        error={errors.password}
        disabled={pending}
        trailing={
          <PasswordVisibilityToggle
            visible={showPassword}
            onToggle={() => setShowPassword((v) => !v)}
          />
        }
      />
      <Checkbox
        label="Keep me logged in on this device"
        name="persist"
        checked={persist}
        onChange={(e) => setPersist(e.target.checked)}
        disabled={pending}
      />
    </form>
  );
}

export default LoginForm;
