import { useState, useTransition, type SubmitEvent } from "react";
import { Link, useNavigate } from "react-router";
import { FiArrowRight, FiEye, FiEyeOff, FiLoader } from "react-icons/fi";
import toast from "react-hot-toast";
import Logo from "../../components/Logo.tsx";
import TextField from "../../components/TextField.tsx";
import PasswordStrengthMeter from "../../components/PasswordStrengthMeter.tsx";
import { registerUser } from "../../api/users.ts";
import { usePasswordStrength } from "../../hooks/usePasswordStrength.ts";
import {
  validateRegisterForm,
  type RegisterForm,
  type RegisterFormErrors,
} from "./validate.ts";

// Shared id so repeated failed submits replace the toast instead of stacking.
const REGISTER_ERROR_TOAST = "register-error";

function RegisterPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState<RegisterForm>({
    username: "",
    password: "",
    confirmPassword: "",
  });
  const [errors, setErrors] = useState<RegisterFormErrors>({});
  const [showPassword, setShowPassword] = useState(false);
  const [isPending, startTransition] = useTransition();
  const strength = usePasswordStrength(form.password, [form.username]);

  function updateField(field: keyof RegisterForm, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
  }

  function handleSubmit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();

    const validationErrors = validateRegisterForm(form);
    setErrors(validationErrors);
    if (Object.keys(validationErrors).length > 0) return;

    startTransition(async () => {
      try {
        const result = await registerUser(form.username, form.password);
        if (result.success) {
          // TODO: auto-login once the login flow is built, instead of
          // sending the user to /login.
          navigate("/login");
        } else if (result.code === "USER_ALREADY_EXISTS") {
          setErrors({ username: "That username is taken." });
        } else {
          toast.error("Registration failed. Please try again.", {
            id: REGISTER_ERROR_TOAST,
          });
        }
      } catch {
        toast.error("Couldn't reach the server. Check your connection.", {
          id: REGISTER_ERROR_TOAST,
        });
      }
    });
  }

  const visibilityToggle = (
    <button
      type="button"
      onClick={() => setShowPassword((v) => !v)}
      aria-label={showPassword ? "Hide password" : "Show password"}
      aria-pressed={showPassword}
      className="grid size-9 place-items-center rounded-lg text-ink-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-focus"
    >
      {showPassword ? <FiEyeOff aria-hidden /> : <FiEye aria-hidden />}
    </button>
  );

  return (
    <main className="flex min-h-svh items-center justify-center p-4 sm:p-6">
      <div className="grid w-full max-w-5xl gap-4 lg:grid-cols-[1.1fr_1fr]">
        <section className="hidden flex-col justify-between gap-12 rounded-3xl bg-lime p-10 text-ink-on-lime lg:flex">
          <Logo onLime />
          <h1 className="font-display text-6xl leading-[0.95] font-extrabold tracking-tight">
            Your money,
            <br />
            your keys.
          </h1>
          <p className="max-w-sm font-mono text-sm leading-relaxed">
            We use{" "}
            <a
              href="https://opaque-auth.com/"
              target="_blank"
              rel="noreferrer"
              className="font-semibold underline underline-offset-4 outline-none hover:decoration-2 focus-visible:ring-2 focus-visible:ring-ink-on-lime"
            >
              OPAQUE
            </a>{" "}
            authentication so your password isn't sent to the server. All user
            data is encrypted before being uploaded.
          </p>
        </section>

        <section className="flex min-w-0 flex-col gap-8 rounded-3xl border border-line bg-surface p-6 sm:p-10">
          <div className="lg:hidden">
            <Logo />
          </div>

          <header className="flex flex-col gap-2">
            <h2 className="font-display text-3xl font-bold tracking-tight">
              Create your account
            </h2>
            <p className="text-ink-muted">
              Already have one?{" "}
              <Link
                to="/login"
                className="font-medium text-ink underline underline-offset-4 outline-none hover:decoration-2 focus-visible:ring-2 focus-visible:ring-focus"
              >
                Log in →
              </Link>
            </p>
          </header>

          <form
            onSubmit={handleSubmit}
            noValidate
            className="flex flex-col gap-5"
          >
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
              disabled={isPending}
            />
            <TextField
              label="Password"
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              value={form.password}
              onChange={(e) => updateField("password", e.target.value)}
              hint={
                <PasswordStrengthMeter
                  result={strength}
                  invalid={errors.password !== undefined}
                />
              }
              invalid={errors.password !== undefined}
              disabled={isPending}
              trailing={visibilityToggle}
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
              disabled={isPending}
            />

            <button
              type="submit"
              disabled={isPending}
              className="mt-2 inline-flex items-center justify-center gap-2 rounded-full bg-lime px-6 py-3.5 font-semibold text-ink-on-lime transition outline-none hover:brightness-95 focus-visible:ring-3 focus-visible:ring-focus focus-visible:ring-offset-3 focus-visible:ring-offset-surface disabled:cursor-not-allowed disabled:opacity-70"
            >
              {isPending ? (
                <>
                  <FiLoader className="animate-spin" aria-hidden />
                  Creating account…
                </>
              ) : (
                <>
                  Create account
                  <FiArrowRight aria-hidden />
                </>
              )}
            </button>
          </form>
        </section>
      </div>
    </main>
  );
}

export default RegisterPage;
