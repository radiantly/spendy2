import { createStore, set } from "idb-keyval";
import { describe, expect, it } from "vitest";
import { deriveKek } from "./kek.ts";
import { clearSession, loadSession, saveSession, type Session } from "./session.ts";

// A valid base64url export key (bytes 0x00..0x3f).
const EXPORT_KEY =
  "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-Pw";

async function makeSession(): Promise<Session> {
  return { username: "alice", token: "dG9rZW4=", kek: await deriveKek(EXPORT_KEY) };
}

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
    await set("current", { username: "alice", token: 42 }, createStore("spendy", "session"));

    expect(await loadSession()).toBeNull();
  });

  it("clears the session", async () => {
    await saveSession(await makeSession());
    await clearSession();

    expect(await loadSession()).toBeNull();
  });
});
