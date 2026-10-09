import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";
import AuthProvider from "./AuthProvider.tsx";
import { useAuth } from "./useAuth.ts";
import { loginUser } from "../api/auth.ts";
import { deriveKek } from "../lib/kek.ts";
import { loadSession, saveSession } from "../lib/session.ts";
import { EXPORT_KEY, TOKEN } from "../test/fixtures.ts";

vi.mock("../api/auth.ts", () => ({ loginUser: vi.fn() }));
// Real storage, but wrapped so a test can make it fail.
vi.mock("../lib/session.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/session.ts")>();
  return {
    ...actual,
    loadSession: vi.fn(actual.loadSession),
    saveSession: vi.fn(actual.saveSession),
  };
});

beforeEach(() => {
  vi.mocked(loginUser).mockReset();
  vi.mocked(loginUser).mockResolvedValue({ success: true, token: TOKEN, exportKey: EXPORT_KEY });
});

function renderAuth() {
  return renderHook(() => useAuth(), { wrapper: AuthProvider });
}

async function storeSession(username = "alice") {
  await saveSession({ username, token: TOKEN, kek: await deriveKek(EXPORT_KEY) });
}

describe("AuthProvider", () => {
  it("starts loading, then becomes anonymous without a stored session", async () => {
    const { result } = await renderAuth();

    await expect.poll(() => result.current.state.status).toBe("anonymous");
  });

  it("restores a stored session", async () => {
    await storeSession("bob");

    const { result } = await renderAuth();

    await expect.poll(() => result.current.state.status).toBe("authenticated");
    const { state } = result.current;
    expect(state.status === "authenticated" && state.session.username).toBe("bob");
  });

  it("becomes anonymous when the stored session can't be read", async () => {
    vi.mocked(loadSession).mockRejectedValueOnce(new DOMException("blocked", "SecurityError"));

    const { result } = await renderAuth();

    await expect.poll(() => result.current.state.status).toBe("anonymous");
  });

  it("logs in and saves the session when persisting", async () => {
    const { result, act } = await renderAuth();
    await expect.poll(() => result.current.state.status).toBe("anonymous");

    let outcome;
    await act(async () => {
      outcome = await result.current.login("alice", "pw", { persist: true });
    });

    expect(outcome).toEqual({ success: true, persisted: true });
    expect(result.current.state.status).toBe("authenticated");
    expect(await loadSession()).toMatchObject({ username: "alice", token: TOKEN });
  });

  it("logs in without saving when not persisting, and drops an old session", async () => {
    await storeSession("bob");
    const { result, act } = await renderAuth();
    await expect.poll(() => result.current.state.status).toBe("authenticated");

    let outcome;
    await act(async () => {
      outcome = await result.current.login("alice", "pw", { persist: false });
    });

    expect(outcome).toEqual({ success: true, persisted: false });
    const { state } = result.current;
    expect(state.status === "authenticated" && state.session.username).toBe("alice");
    expect(await loadSession()).toBeNull();
  });

  it("stays logged in for this visit when the session can't be saved", async () => {
    vi.mocked(saveSession).mockRejectedValueOnce(new DOMException("full", "QuotaExceededError"));
    const { result, act } = await renderAuth();
    await expect.poll(() => result.current.state.status).toBe("anonymous");

    let outcome;
    await act(async () => {
      outcome = await result.current.login("alice", "pw", { persist: true });
    });

    expect(outcome).toEqual({ success: true, persisted: false });
    expect(result.current.state.status).toBe("authenticated");
    expect(await loadSession()).toBeNull();
  });

  it("returns the failure and stays anonymous when login fails", async () => {
    vi.mocked(loginUser).mockResolvedValue({ success: false, code: "INVALID_LOGIN" });
    const { result, act } = await renderAuth();
    await expect.poll(() => result.current.state.status).toBe("anonymous");

    let outcome;
    await act(async () => {
      outcome = await result.current.login("alice", "wrong", { persist: true });
    });

    expect(outcome).toEqual({ success: false, code: "INVALID_LOGIN" });
    expect(result.current.state.status).toBe("anonymous");
    expect(await loadSession()).toBeNull();
  });

  it("throws outside an AuthProvider", async () => {
    await expect(renderHook(() => useAuth())).rejects.toThrow(
      "useAuth must be used inside <AuthProvider>",
    );
  });
});
