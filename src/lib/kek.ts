/**
 * Key-encryption key (KEK) derived from the OPAQUE export key. It only wraps
 * and unwraps data keys (AES-KW); the database itself is encrypted with a
 * per-upload AES-GCM data key.
 *
 * The derivation must stay stable: the scripts derive the same KEK from the
 * export key in session.json, and changing `KEK_INFO` makes every existing
 * wrapped key unrecoverable. Bump the version suffix only alongside a
 * migration.
 */
const KEK_INFO = new TextEncoder().encode("spendy/kek/v1");

export async function deriveKek(exportKey: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    base64UrlToBytes(exportKey),
    "HKDF",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: KEK_INFO },
    material,
    { name: "AES-KW", length: 256 },
    false,
    ["wrapKey", "unwrapKey"],
  );
}

/** @serenity-kit/opaque encodes keys as unpadded base64url. */
function base64UrlToBytes(input: string): Uint8Array<ArrayBuffer> {
  const base64 = input.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
