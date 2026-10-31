import { createStore, get, set } from "idb-keyval";
import { describe, expect, it } from "vitest";
import { deriveKek } from "./kek.ts";
import {
  clearSession,
  loadSession,
  saveRowNumberDigits,
  saveSession,
  type Session,
} from "./session.ts";

// A valid base64url export key (bytes 0x00..0x3f).
const EXPORT_KEY =
  "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-Pw";

async function makeSession(token = "dG9rZW4="): Promise<Session> {
  return { username: "alice", token, kek: await deriveKek(EXPORT_KEY) };
}

/** The store session.ts uses. */
const sessionStore = createStore("spendy", "session");

describe("session storage", () => {
  it("returns null when nothing is stored", async () => {
    expect(await loadSession()).toBeNull();
  });

  it("restores a saved session with a working KEK", async () => {
    await saveSession(await makeSession());

    const loaded = await loadSession();
    expect(loaded).toMatchObject({ username: "alice", token: "dG9rZW4=" });

    // The CryptoKey survives IndexedDB and still wraps and unwraps.
    const dataKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
    ]);
    const wrapped = await crypto.subtle.wrapKey("raw", dataKey, loaded!.kek, "AES-KW");
    await expect(
      crypto.subtle.unwrapKey("raw", wrapped, loaded!.kek, "AES-KW", "AES-GCM", true, ["encrypt"]),
    ).resolves.toBeInstanceOf(CryptoKey);
  });

  it("keeps the KEK non-extractable after a round trip", async () => {
    await saveSession(await makeSession());

    expect((await loadSession())!.kek.extractable).toBe(false);
  });

  it("returns null for a malformed stored session", async () => {
    // Same database and store that session.ts uses.
    await set("current", { username: "alice", token: 42 }, sessionStore);

    expect(await loadSession()).toBeNull();
  });

  it("clears the session", async () => {
    await saveSession(await makeSession());
    await clearSession();

    expect(await loadSession()).toBeNull();
  });
});

describe("the row numbers' digits kept with the session", () => {
  it("keeps them with the session they're for, which keeps its KEK", async () => {
    await saveSession(await makeSession());

    await saveRowNumberDigits("dG9rZW4=", 4);

    const loaded = await loadSession();
    expect(loaded).toMatchObject({ username: "alice", token: "dG9rZW4=", rowNumberDigits: 4 });
    expect(loaded!.kek.extractable).toBe(false);
  });

  it("leaves a newer login alone", async () => {
    await saveSession(await makeSession("bmV3ZXI="));

    await saveRowNumberDigits("dG9rZW4=", 4);

    const loaded = await loadSession();
    expect(loaded!.token).toBe("bmV3ZXI=");
    expect(loaded!.rowNumberDigits).toBeUndefined();
  });

  it("stores nothing without a session, as when the login isn't remembered", async () => {
    await saveRowNumberDigits("dG9rZW4=", 4);

    expect(await get("current", sessionStore)).toBeUndefined();
  });

  it("goes with the session", async () => {
    await saveSession(await makeSession());
    await saveRowNumberDigits("dG9rZW4=", 4);

    await clearSession();

    expect(await get("current", sessionStore)).toBeUndefined();
  });

  it("drops malformed ones, keeping the session", async () => {
    await saveSession(await makeSession());
    await set(
      "current",
      { ...(await get("current", sessionStore)), rowNumberDigits: "four" },
      sessionStore,
    );

    const loaded = await loadSession();
    expect(loaded).toMatchObject({ username: "alice", token: "dG9rZW4=" });
    expect(loaded!.rowNumberDigits).toBeUndefined();
  });
});
