import { useState, type SubmitEvent, type TransitionStartFunction } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import TextField from "../../components/TextField.tsx";
import PasswordStrengthMeter from "../../components/PasswordStrengthMeter.tsx";
import PasswordVisibilityToggle from "../../components/PasswordVisibilityToggle.tsx";
import { registerUser } from "../../api/users.ts";
import { useAuth } from "../../auth/useAuth.ts";
import { usePasswordStrength } from "../../hooks/usePasswordStrength.ts";
import { warnSessionNotSaved } from "./toasts.ts";
import {
  validateRegisterForm,
  type RegisterFormValues,
  type RegisterFormErrors,
} from "./validate.ts";

// Shared id so repeated failed submits replace the toast instead of stacking.
const REGISTER_ERROR_TOAST = "register-error";

type FormProps = {
  id: string;
  /** Owned by AuthPage, which renders the submit button for this form. */
  pending: boolean;
  startTransition: TransitionStartFunction;
};

/** On success the user is logged in, and AuthPage redirects away. */
function RegisterForm({ id, pending, startTransition }: FormProps) {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [form, setForm] = useState<RegisterFormValues>({
    username: "",
    password: "",
    confirmPassword: "",
  });
  const [errors, setErrors] = useState<RegisterFormErrors>({});
  const [showPassword, setShowPassword] = useState(false);
  const strength = usePasswordStrength(form.password, [form.username]);

  function updateField(field: keyof RegisterFormValues, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  }

  function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();

    const validationErrors = validateRegisterForm(form);
    setErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) return;

    startTransition(async () => {
      let result;
      try {
        result = await registerUser(form.username, form.password);
      } catch {
        toast.error("Couldn't reach the server. Check your connection.", {
          id: REGISTER_ERROR_TOAST,
        });
        return;
      }

      if (!result.success) {
        if (result.code === "USER_ALREADY_EXISTS") {
          setErrors({ username: "That username is taken." });
        } else {
          toast.error("Registration failed. Please try again.", { id: REGISTER_ERROR_TOAST });
        }
        return;
      }

      // Logging in straight away also keeps the server from cleaning up the
      // account as one that was never used.
      const outcome = await login(form.username, form.password, { persist: true }).catch(
        () => null,
      );
      if (!outcome?.success) {
        toast.error("Account created, but logging in failed. Please log in.", {
          id: REGISTER_ERROR_TOAST,
        });
        navigate("/login");
      } else if (!outcome.persisted) {
        warnSessionNotSaved();
      }
    });
  }

  return (
    <form id={id} onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
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
        autoComplete="new-password"
        value={form.password}
        onChange={(e) => updateField("password", e.target.value)}
        hint={<PasswordStrengthMeter result={strength} invalid={errors.password !== undefined} />}
        invalid={errors.password !== undefined}
        disabled={pending}
        trailing={
          <PasswordVisibilityToggle
            visible={showPassword}
            onToggle={() => setShowPassword((v) => !v)}
            disabled={pending}
          />
        }
      />
      <TextField
        label="Confirm password"
        name="confirmPassword"
        type="password"
        autoComplete="new-password"
        value={form.confirmPassword}
        onChange={(e) => updateField("confirmPassword", e.target.value)}
        hint="Re-enter the password above"
        error={errors.confirmPassword}
        disabled={pending}
      />
    </form>
  );
}

export default RegisterForm;
