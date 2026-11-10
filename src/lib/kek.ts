/**
 * Key-encryption key (KEK) derived from the OPAQUE export key. It only wraps
 * and unwraps data keys (AES-KW); the database itself is encrypted with a
 * per-upload AES-GCM data key.
 *
 * The derivation must stay stable: the scripts keep the KEK's bytes with
 * their session (see scripts/userData.ts), and changing `KEK_INFO` makes
 * every existing wrapped key unrecoverable. Bump the version suffix only
 * alongside a migration.
 */
const KEK_INFO = new TextEncoder().encode("spendy/kek/v1");
const KEK_BITS = 256;

/** The KEK, as a key that can't be read back out. */
export async function deriveKek(exportKey: string): Promise<CryptoKey> {
  return importKek(await deriveKekBytes(exportKey));
}

/**
 * The KEK's bytes, for keeping it where a CryptoKey can't be stored: the
 * scripts keep these rather than the export key, which they could derive
 * more than the KEK from.
 */
export async function deriveKekBytes(exportKey: string): Promise<Uint8Array<ArrayBuffer>> {
  const material = await crypto.subtle.importKey(
    "raw",
    base64UrlToBytes(exportKey),
    "HKDF",
    false,
    ["deriveBits"],
  );

  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: KEK_INFO },
      material,
      KEK_BITS,
    ),
  );
}

/** The KEK `deriveKekBytes` gave the bytes of. */
export async function importKek(bytes: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (bytes.length * 8 !== KEK_BITS) throw new Error("Not a KEK");
  return crypto.subtle.importKey("raw", bytes, "AES-KW", false, ["wrapKey", "unwrapKey"]);
}

/** @serenity-kit/opaque encodes keys as unpadded base64url. */
function base64UrlToBytes(input: string): Uint8Array<ArrayBuffer> {
  const base64 = input.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
