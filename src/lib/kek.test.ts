import * as opaque from "@serenity-kit/opaque";
import { describe, expect, it } from "vitest";
import { deriveKek, deriveKekBytes, importKek } from "./kek.ts";

/**
 * Independent test vector, computed with Node's crypto (HKDF-SHA256 with an
 * empty salt and info "spendy/kek/v1", then RFC 3394 AES-256 key wrap):
 * export key = bytes 0x00..0x3f, data key = bytes 0xa0..0xbf.
 *
 * If this test fails, the derivation changed, and every key wrapped with the
 * old KEK (including by the scripts) can no longer be unwrapped.
 */
const VECTOR = {
  exportKey:
    "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-Pw",
  dataKey: Uint8Array.from({ length: 32 }, (_, i) => 0xa0 + i),
  wrapped: "e72bda67d5274f85f740d9de73464d16762ff72e0ecdfbb9e690e429dcdebafcd7f644f7ae7b0b89",
};

function importDataKey(bytes: Uint8Array<ArrayBuffer>) {
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", true, ["encrypt", "decrypt"]);
}

async function wrapHex(kek: CryptoKey, dataKey: CryptoKey) {
  const wrapped = new Uint8Array(await crypto.subtle.wrapKey("raw", dataKey, kek, "AES-KW"));
  return Array.from(wrapped, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("deriveKek", () => {
  it("matches the pinned test vector", async () => {
    const kek = await deriveKek(VECTOR.exportKey);

    expect(await wrapHex(kek, await importDataKey(VECTOR.dataKey))).toBe(VECTOR.wrapped);
  });

  it("derives a non-extractable AES-KW-256 key that can only wrap and unwrap", async () => {
    const kek = await deriveKek(VECTOR.exportKey);

    expect(kek.algorithm).toEqual({ name: "AES-KW", length: 256 });
    expect(kek.extractable).toBe(false);
    expect([...kek.usages].sort()).toEqual(["unwrapKey", "wrapKey"]);
  });

  it("unwraps what it wrapped", async () => {
    const kek = await deriveKek(VECTOR.exportKey);
    const dataKey = await importDataKey(VECTOR.dataKey);
    const wrapped = await crypto.subtle.wrapKey("raw", dataKey, kek, "AES-KW");

    const unwrapped = await crypto.subtle.unwrapKey(
      "raw",
      wrapped,
      await deriveKek(VECTOR.exportKey),
      "AES-KW",
      "AES-GCM",
      true,
      ["decrypt"],
    );
    expect(new Uint8Array(await crypto.subtle.exportKey("raw", unwrapped))).toEqual(VECTOR.dataKey);
  });

  it("derives a different key from a different export key", async () => {
    const dataKey = await importDataKey(VECTOR.dataKey);
    const other = VECTOR.exportKey.replace(/^A/, "B");

    expect(await wrapHex(await deriveKek(other), dataKey)).not.toBe(VECTOR.wrapped);
  });

  it("rejects input that isn't base64url", async () => {
    await expect(deriveKek("not base64!")).rejects.toThrow();
  });

  it("accepts an export key produced by OPAQUE", async () => {
    await opaque.ready;
    const serverSetup = opaque.server.createSetup();
    const password = "correct horse battery staple";

    const registration = opaque.client.startRegistration({ password });
    const { registrationResponse } = opaque.server.createRegistrationResponse({
      serverSetup,
      userIdentifier: "alice",
      registrationRequest: registration.registrationRequest,
    });
    const { exportKey } = opaque.client.finishRegistration({
      clientRegistrationState: registration.clientRegistrationState,
      registrationResponse,
      password,
    });

    await expect(deriveKek(exportKey)).resolves.toBeInstanceOf(CryptoKey);
  });
});

describe("importKek", () => {
  it("gives the key deriveKek does, from the bytes deriveKekBytes gave", async () => {
    const kek = await importKek(await deriveKekBytes(VECTOR.exportKey));

    expect(await wrapHex(kek, await importDataKey(VECTOR.dataKey))).toBe(VECTOR.wrapped);
    expect(kek.extractable).toBe(false);
  });

  it("rejects bytes that aren't a KEK's length", async () => {
    await expect(importKek(new Uint8Array(16))).rejects.toThrow();
  });
});
