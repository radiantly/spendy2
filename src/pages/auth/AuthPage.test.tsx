import { beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import type { RenderResult } from "vitest-browser-react";
import { loginUser, registerUser, type LoginResult } from "../../api/auth.ts";
import { deriveKek } from "../../lib/kek.ts";
import { clearSession, loadSession, saveSession } from "../../lib/session.ts";
import { loadPasswordStrengthEstimator } from "../../lib/passwordStrength.ts";
import { EXPORT_KEY, TOKEN } from "../../test/fixtures.ts";
import { rect, renderApp, visible } from "../../test/renderAuthPage.tsx";

vi.mock("../../api/auth.ts", () => ({ loginUser: vi.fn(), registerUser: vi.fn() }));
// Real implementations, wrapped so tests can observe or break them.
vi.mock("../../lib/session.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/session.ts")>();
  return {
    ...actual,
    saveSession: vi.fn(actual.saveSession),
    clearSession: vi.fn(actual.clearSession),
  };
});
vi.mock("../../lib/passwordStrength.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/passwordStrength.ts")>();
  return { loadPasswordStrengthEstimator: vi.fn(actual.loadPasswordStrengthEstimator) };
});

const LOGGED_IN: LoginResult = { success: true, token: TOKEN, exportKey: EXPORT_KEY };
const CONNECTION_ERROR = "Couldn't reach the server. Check your connection.";
const SESSION_NOT_SAVED =
  "Logged in, but this device couldn't save your session. You'll need to log in again next time.";

beforeEach(async () => {
  vi.mocked(loginUser).mockReset().mockResolvedValue(LOGGED_IN);
  vi.mocked(registerUser).mockReset().mockResolvedValue({ success: true });
  vi.mocked(loadPasswordStrengthEstimator).mockClear();
  // Back to the real implementations, dropping any unused queued failures.
  vi.mocked(saveSession).mockReset();
  vi.mocked(clearSession).mockReset();
  // The default viewport is phone-sized; layout tests opt into desktop.
  await page.viewport(414, 896);
});

function field(screen: RenderResult, label: string) {
  return visible(screen.getByLabelText(label));
}

function submitButton(screen: RenderResult) {
  return screen.getByRole("button", {
    name: /^(Log in|Logging in…|Create account|Creating account…)$/,
  });
}

async function fillLogin(screen: RenderResult, username = "alice", password = "pw") {
  await field(screen, "Username").fill(username);
  await field(screen, "Password").fill(password);
}

async function fillRegister(screen: RenderResult, username = "alice", password = "pw") {
  await field(screen, "Username").fill(username);
  await field(screen, "Password").fill(password);
  await field(screen, "Confirm password").fill(password);
}

function messageFor(screen: RenderResult, label: string) {
  const id = field(screen, label).element().getAttribute("aria-describedby");
  return id ? document.getElementById(id)?.textContent : undefined;
}

/** The slot (direct child of the stacking grid) that holds a form. */
function slotOf(screen: RenderResult, autoComplete: "current-password" | "new-password") {
  return screen.container.querySelector(`input[autocomplete="${autoComplete}"]`)!.closest("form")!
    .parentElement!;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("routing", () => {
  it("redirects to the dashboard when already logged in", async () => {
    await saveSession({ username: "alice", token: TOKEN, kek: await deriveKek(EXPORT_KEY) });

    const { router } = await renderApp("/login");

    await expect.poll(() => router.state.location.pathname).toBe("/");
  });

  it("switches between login and register with the header link", async () => {
    const { router, screen } = await renderApp("/login");
    await expect
      .element(screen.getByRole("heading", { name: "Log in to your account" }))
      .toBeVisible();

    await screen.getByRole("link", { name: "Create an account →" }).click();

    expect(router.state.location.pathname).toBe("/register");
    await expect
      .element(screen.getByRole("heading", { name: "Create your account" }))
      .toBeVisible();
    await expect.element(submitButton(screen)).toHaveTextContent("Create account");
  });

  it("makes the inactive form inert and points the button at the active one", async () => {
    const { screen } = await renderApp("/login");

    const loginForm = slotOf(screen, "current-password").querySelector("form")!;
    expect(slotOf(screen, "new-password").inert).toBe(true);
    expect(slotOf(screen, "current-password").inert).toBe(false);
    expect((submitButton(screen).element() as HTMLButtonElement).form).toBe(loginForm);
  });
});

describe("login", () => {
  it("validates before calling the server", async () => {
    const { screen } = await renderApp("/login");

    await submitButton(screen).click();

    expect(messageFor(screen, "Username")).toBe("Use 3–32 lowercase letters or numbers.");
    expect(messageFor(screen, "Password")).toBe("Enter your password.");
    expect(loginUser).not.toHaveBeenCalled();
  });

  it("logs in, saves the session and goes to the dashboard", async () => {
    const { router, screen } = await renderApp("/login");
    await fillLogin(screen);

    await submitButton(screen).click();

    await expect.poll(() => router.state.location.pathname).toBe("/");
    expect(loginUser).toHaveBeenCalledWith("alice", "pw");
    expect(await loadSession()).toMatchObject({ username: "alice" });
  });

  it("submits when Enter is pressed in the password field", async () => {
    const { router, screen } = await renderApp("/login");
    await fillLogin(screen);

    await field(screen, "Password").click();
    await userEvent.keyboard("{Enter}");

    await expect.poll(() => router.state.location.pathname).toBe("/");
  });

  it("doesn't save the session when 'keep me logged in' is unchecked", async () => {
    const { router, screen } = await renderApp("/login");
    await fillLogin(screen);

    await screen.getByRole("checkbox", { name: "Keep me logged in on this device" }).click();
    await submitButton(screen).click();

    await expect.poll(() => router.state.location.pathname).toBe("/");
    expect(await loadSession()).toBeNull();
  });

  it("shows a wrong password under the password field", async () => {
    vi.mocked(loginUser).mockResolvedValue({ success: false, code: "INVALID_LOGIN" });
    const { screen } = await renderApp("/login");
    await fillLogin(screen);

    await submitButton(screen).click();

    await expect.poll(() => messageFor(screen, "Password")).toBe("Incorrect username or password.");
    await expect.element(field(screen, "Password")).toHaveAttribute("aria-invalid", "true");
  });

  it.each([
    ["RATE_LIMITED", "Too many attempts. Wait a few seconds and try again."],
    ["LOGIN_FAILED", "Login failed. Please try again."],
  ] as const)("shows a toast for %s", async (code, message) => {
    vi.mocked(loginUser).mockResolvedValue({ success: false, code });
    const { screen } = await renderApp("/login");
    await fillLogin(screen);

    await submitButton(screen).click();

    await expect.element(page.getByText(message)).toBeVisible();
  });

  it("shows a toast when the server can't be reached", async () => {
    vi.mocked(loginUser).mockRejectedValue(new TypeError("Failed to fetch"));
    const { screen } = await renderApp("/login");
    await fillLogin(screen);

    await submitButton(screen).click();

    await expect.element(page.getByText(CONNECTION_ERROR)).toBeVisible();
  });

  it("disables the form and shows progress while logging in", async () => {
    const pending = deferred<LoginResult>();
    vi.mocked(loginUser).mockReturnValue(pending.promise);
    const { screen } = await renderApp("/login");
    await fillLogin(screen);

    await submitButton(screen).click();

    await expect.element(submitButton(screen)).toHaveTextContent("Logging in…");
    await expect.element(submitButton(screen)).toBeDisabled();
    await expect.element(field(screen, "Username")).toBeDisabled();
    await expect
      .element(visible(screen.getByRole("button", { name: "Show password" })))
      .toBeDisabled();
    await expect
      .element(screen.getByRole("checkbox", { name: "Keep me logged in on this device" }))
      .toBeDisabled();
    pending.resolve({ success: false, code: "INVALID_LOGIN" });
  });

  // React holds navigations back while the submit is pending, so following
  // the link would only switch once the login settles. It's disabled instead.
  it("disables the header link while a login is pending", async () => {
    const pending = deferred<LoginResult>();
    vi.mocked(loginUser).mockReturnValue(pending.promise);
    const { router, screen } = await renderApp("/login");
    await fillLogin(screen);
    await submitButton(screen).click();
    await expect.element(submitButton(screen)).toHaveTextContent("Logging in…");

    const link = screen.getByRole("link", { name: "Create an account →" });
    try {
      await expect.element(link).toHaveAttribute("aria-disabled", "true");
      // Playwright refuses to click aria-disabled elements, so activate it
      // directly, as a keyboard user pressing Enter would.
      (link.element() as HTMLAnchorElement).click();
      expect(router.state.location.pathname).toBe("/login");
    } finally {
      // A pending transition would hold back navigations in later tests.
      pending.resolve({ success: false, code: "INVALID_LOGIN" });
    }

    await expect.element(link).not.toHaveAttribute("aria-disabled");
    await link.click();
    await expect
      .element(screen.getByRole("heading", { name: "Create your account" }))
      .toBeVisible();
  });

  it("stays logged in with a warning when the session can't be saved", async () => {
    vi.mocked(saveSession).mockRejectedValueOnce(new DOMException("full", "QuotaExceededError"));
    const { router, screen } = await renderApp("/login");
    await fillLogin(screen);

    await submitButton(screen).click();

    await expect.poll(() => router.state.location.pathname).toBe("/");
    await expect.element(page.getByText(SESSION_NOT_SAVED)).toBeVisible();
    await expect.element(page.getByText(CONNECTION_ERROR)).not.toBeInTheDocument();
    expect(await loadSession()).toBeNull();
  });

  it("doesn't warn about saving when 'keep me logged in' is unchecked", async () => {
    vi.mocked(clearSession).mockRejectedValueOnce(new DOMException("full", "QuotaExceededError"));
    const { router, screen } = await renderApp("/login");
    await fillLogin(screen);
    await screen.getByRole("checkbox", { name: "Keep me logged in on this device" }).click();

    await submitButton(screen).click();

    await expect.poll(() => router.state.location.pathname).toBe("/");
    await expect.element(page.getByText(SESSION_NOT_SAVED)).not.toBeInTheDocument();
  });
});

describe("register", () => {
  it("validates before calling the server", async () => {
    const { screen } = await renderApp("/register");
    await field(screen, "Username").fill("Alice");
    await field(screen, "Password").fill("pw");
    await field(screen, "Confirm password").fill("pW");

    await submitButton(screen).click();

    expect(messageFor(screen, "Username")).toBe("Use 3–32 lowercase letters or numbers.");
    expect(messageFor(screen, "Confirm password")).toBe("Passwords don't match.");
    expect(registerUser).not.toHaveBeenCalled();
  });

  it("registers, logs in automatically and goes to the dashboard", async () => {
    const { router, screen } = await renderApp("/register");
    await fillRegister(screen);

    await submitButton(screen).click();

    await expect.poll(() => router.state.location.pathname).toBe("/");
    expect(registerUser).toHaveBeenCalledWith("alice", "pw");
    expect(loginUser).toHaveBeenCalledWith("alice", "pw");
    expect(await loadSession()).toMatchObject({ username: "alice" });
  });

  it("warns when the automatic login's session can't be saved", async () => {
    vi.mocked(saveSession).mockRejectedValueOnce(new DOMException("full", "QuotaExceededError"));
    const { router, screen } = await renderApp("/register");
    await fillRegister(screen);

    await submitButton(screen).click();

    await expect.poll(() => router.state.location.pathname).toBe("/");
    await expect.element(page.getByText(SESSION_NOT_SAVED)).toBeVisible();
  });

  it("shows a taken username under the username field", async () => {
    vi.mocked(registerUser).mockResolvedValue({ success: false, code: "USER_ALREADY_EXISTS" });
    const { screen } = await renderApp("/register");
    await fillRegister(screen);

    await submitButton(screen).click();

    await expect.poll(() => messageFor(screen, "Username")).toBe("That username is taken.");
  });

  it("shows a toast when registration fails", async () => {
    vi.mocked(registerUser).mockResolvedValue({ success: false, code: "REGISTRATION_FAILED" });
    const { screen } = await renderApp("/register");
    await fillRegister(screen);

    await submitButton(screen).click();

    await expect.element(page.getByText("Registration failed. Please try again.")).toBeVisible();
  });

  it("shows a toast when the server can't be reached", async () => {
    vi.mocked(registerUser).mockRejectedValue(new TypeError("Failed to fetch"));
    const { screen } = await renderApp("/register");
    await fillRegister(screen);

    await submitButton(screen).click();

    await expect.element(page.getByText(CONNECTION_ERROR)).toBeVisible();
  });

  it("sends the user to log in when the automatic login fails", async () => {
    vi.mocked(loginUser).mockResolvedValue({ success: false, code: "LOGIN_FAILED" });
    const { router, screen } = await renderApp("/register");
    await fillRegister(screen);

    await submitButton(screen).click();

    await expect.poll(() => router.state.location.pathname).toBe("/login");
    await expect
      .element(page.getByText("Account created, but logging in failed. Please log in."))
      .toBeVisible();
  });

  it("only loads the strength estimator once a password is typed", async () => {
    const { screen } = await renderApp("/login");
    await screen.getByRole("link", { name: "Create an account →" }).click();
    await field(screen, "Username").fill("alice");

    expect(loadPasswordStrengthEstimator).not.toHaveBeenCalled();

    await field(screen, "Password").fill("p");

    await expect.poll(() => vi.mocked(loadPasswordStrengthEstimator).mock.calls.length).toBe(1);
  });
});

describe("layout", () => {
  async function measure(screen: RenderResult) {
    const heading = screen.getByRole("heading", { level: 2 });
    const card = heading.element().closest("section")!;
    const header = heading.element().closest("header")!.getBoundingClientRect();
    const grid = slotOf(screen, "current-password").parentElement!.getBoundingClientRect();
    const button = rect(submitButton(screen));
    return {
      link: rect(visible(screen.getByRole("link", { name: /→$/ }))).top,
      button: button.top,
      card: card.getBoundingClientRect().height,
      gapAbove: grid.top - header.bottom,
      gapBelow: button.top - grid.bottom,
    };
  }

  it("keeps the header link and button in place when switching on desktop", async () => {
    await page.viewport(1280, 900);
    const { screen } = await renderApp("/login");
    const login = await measure(screen);

    await screen.getByRole("link", { name: "Create an account →" }).click();
    await expect
      .element(screen.getByRole("heading", { name: "Create your account" }))
      .toBeVisible();
    const register = await measure(screen);

    expect(register.link).toBe(login.link);
    expect(register.button).toBe(login.button);
    expect(register.card).toBe(login.card);
  });

  it.each(["/login", "/register"])("spaces the form area evenly on %s", async (path) => {
    await page.viewport(1280, 900);
    const { screen } = await renderApp(path);

    const { gapAbove, gapBelow } = await measure(screen);

    expect(gapAbove).toBeGreaterThan(0);
    expect(gapBelow).toBe(gapAbove);
  });

  it.each([
    [1280, 900],
    [375, 812],
  ])("keeps long strength advice inside the card at %ipx", async (width, height) => {
    await page.viewport(width, height);
    const { screen } = await renderApp("/register");

    await field(screen, "Password").fill("hjhjhjhjhjh");

    const advice = screen.getByTitle(/./);
    await expect.element(advice).toBeVisible();
    expect(advice.element().scrollWidth).toBeGreaterThan(advice.element().clientWidth);
    const card = screen.getByRole("heading", { level: 2 }).element().closest("section")!;
    expect(card.scrollWidth).toBe(card.clientWidth);
    expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth);
  });

  it("removes the inactive form from the layout on mobile", async () => {
    await page.viewport(375, 812);
    const { screen } = await renderApp("/login");

    expect(getComputedStyle(slotOf(screen, "new-password")).display).toBe("none");
    expect(getComputedStyle(slotOf(screen, "current-password")).display).toBe("flex");
  });

  it("only shows the account-recovery note on desktop", async () => {
    const note = /your account cannot be recovered/;
    const { screen } = await renderApp("/login");
    await expect.element(screen.getByText(note)).not.toBeVisible();

    await page.viewport(1280, 900);

    await expect.element(screen.getByText(note)).toBeVisible();
  });
});
