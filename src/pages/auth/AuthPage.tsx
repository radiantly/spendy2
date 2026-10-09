import { useId, useTransition, type ReactNode } from "react";
import { Link, Navigate } from "react-router";
import Logo from "../../components/Logo.tsx";
import SubmitButton from "../../components/SubmitButton.tsx";
import { useAuth } from "../../auth/useAuth.ts";
import LoginForm from "./LoginForm.tsx";
import RegisterForm from "./RegisterForm.tsx";

export type AuthMode = "login" | "register";

type ModeCopy = {
  title: string;
  prompt: string;
  link: string;
  to: string;
  submit: string;
  pending: string;
};

const COPY: Record<AuthMode, ModeCopy> = {
  login: {
    title: "Log in to your account",
    prompt: "Don't have one?",
    link: "Create an account →",
    to: "/register",
    submit: "Log in",
    pending: "Logging in…",
  },
  register: {
    title: "Create your account",
    prompt: "Already have one?",
    link: "Log in →",
    to: "/login",
    submit: "Create account",
    pending: "Creating account…",
  },
};

/**
 * Login and register share one page so switching between them doesn't move
 * anything on desktop: both forms are rendered in the same grid cell, and the
 * inactive one is hidden but still takes up space. The card is therefore
 * always as tall as the taller (register) form.
 *
 * On mobile the inactive form is removed instead; the header wraps
 * differently per mode there anyway, and the reserved space would leave a
 * large gap under the login form.
 *
 * The submit button lives outside both forms, so the card's gap applies evenly
 * around the form area. It targets the active form via its `form` attribute,
 * and the page owns the transition so the button can reflect the pending state.
 */
function AuthPage({ mode }: { mode: AuthMode }) {
  const { state } = useAuth();
  const [isPending, startTransition] = useTransition();
  const formId = useId();
  const formIds: Record<AuthMode, string> = {
    login: `${formId}-login`,
    register: `${formId}-register`,
  };

  if (state.status === "authenticated") return <Navigate to="/" replace />;

  const copy = COPY[mode];

  return (
    <main className="flex min-h-svh items-center justify-center p-4 sm:p-6">
      <div className="grid w-full max-w-5xl gap-4 lg:grid-cols-[1.1fr_1fr]">
        <section className="hidden flex-col justify-between gap-12 rounded-3xl bg-lime p-10 text-ink-on-lime lg:flex">
          <Logo onLime />
          <h1 className="font-display text-6xl leading-[1.1] font-extrabold tracking-tight">
            Your spends,
            <br />
            your eyes only.
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
            authentication so your password isn't sent to the server. All user data is encrypted
            before being uploaded.
          </p>
        </section>

        <section className="flex min-w-0 flex-col gap-8 rounded-3xl border border-line bg-surface p-6 sm:p-10">
          <div className="lg:hidden">
            <Logo />
          </div>

          <header className="flex flex-col gap-2">
            <h2 className="font-display text-3xl font-bold tracking-tight">{copy.title}</h2>
            <p className="text-ink-muted">
              {copy.prompt} {/*
               * Disabled while submitting: React holds the navigation back
               * until the submit settles, so the page would switch late.
               */}
              <Link
                to={copy.to}
                aria-disabled={isPending || undefined}
                onClick={(event) => {
                  if (isPending) event.preventDefault();
                }}
                className="font-medium text-ink underline underline-offset-4 outline-none hover:decoration-2 focus-visible:ring-2 focus-visible:ring-focus aria-disabled:cursor-not-allowed aria-disabled:opacity-60 aria-disabled:hover:decoration-1"
              >
                {copy.link}
              </Link>
            </p>
          </header>

          <div className="grid">
            <FormSlot active={mode === "login"}>
              <LoginForm id={formIds.login} pending={isPending} startTransition={startTransition} />
            </FormSlot>
            <FormSlot active={mode === "register"}>
              <RegisterForm
                id={formIds.register}
                pending={isPending}
                startTransition={startTransition}
              />
            </FormSlot>
          </div>

          <SubmitButton form={formIds[mode]} pending={isPending} pendingLabel={copy.pending}>
            {copy.submit}
          </SubmitButton>
        </section>
      </div>
    </main>
  );
}

/**
 * Stacks into the shared cell. On desktop, inactive slots keep their size but
 * can't be seen or focused; on mobile they're removed from the layout.
 * `min-w-0` lets single-line text inside (e.g. the strength advice) truncate
 * instead of widening the slot past the card.
 */
function FormSlot({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div
      className={`col-start-1 row-start-1 min-w-0 flex-col ${active ? "flex" : "hidden lg:invisible lg:flex"}`}
      inert={!active}
    >
      {children}
    </div>
  );
}

export default AuthPage;
