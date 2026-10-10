/**
 * The encrypted database blob stored on the server, version 1:
 *
 *   "SPENDY" | 0x01 | wrapped data key (40) | iv (12) | AES-GCM(gzip(sqlite file))
 *
 * Every encryption uses a fresh AES-256-GCM data key, wrapped with the KEK
 * (AES-KW). The magic and version byte are what the server checks, so they
 * are defined, and validated, by its schema.
 *
 * Runs in the browser and under Node, so the scripts can import it. The
 * layout must stay stable: change it only by adding a new version.
 */

import {
  DATABASE_BLOB_MAGIC,
  DATABASE_BLOB_VERSION,
  databaseBlobSchema,
} from "../../worker/schemas.ts";

/** AES-KW output for a 256-bit key: the key plus an 8-byte integrity block. */
export const WRAPPED_KEY_LENGTH = 40;
export const IV_LENGTH = 12;

export const VERSION_OFFSET = DATABASE_BLOB_MAGIC.length;
export const WRAPPED_KEY_OFFSET = VERSION_OFFSET + 1;
export const IV_OFFSET = WRAPPED_KEY_OFFSET + WRAPPED_KEY_LENGTH;
export const CIPHERTEXT_OFFSET = IV_OFFSET + IV_LENGTH;
/** The GCM tag, so the shortest valid ciphertext. */
const TAG_LENGTH = 16;

export type DatabaseBlobErrorCode = "INVALID_FORMAT" | "UNSUPPORTED_VERSION" | "DECRYPTION_FAILED";

export class DatabaseBlobError extends Error {
  override name = "DatabaseBlobError";
  readonly code: DatabaseBlobErrorCode;

  constructor(code: DatabaseBlobErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export async function encryptDatabase(
  bytes: Uint8Array<ArrayBuffer>,
  kek: CryptoKey,
): Promise<Uint8Array<ArrayBuffer>> {
  const compressed = await transform(bytes, new CompressionStream("gzip"));

  const dataKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
  ]);
  const wrappedKey = new Uint8Array(await crypto.subtle.wrapKey("raw", dataKey, kek, "AES-KW"));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, dataKey, compressed),
  );

  const blob = new Uint8Array(CIPHERTEXT_OFFSET + ciphertext.length);
  blob.set(DATABASE_BLOB_MAGIC, 0);
  blob[VERSION_OFFSET] = DATABASE_BLOB_VERSION;
  blob.set(wrappedKey, WRAPPED_KEY_OFFSET);
  blob.set(iv, IV_OFFSET);
  blob.set(ciphertext, CIPHERTEXT_OFFSET);
  return blob;
}

export async function decryptDatabase(
  blob: Uint8Array<ArrayBuffer>,
  kek: CryptoKey,
): Promise<Uint8Array<ArrayBuffer>> {
  const header = databaseBlobSchema.safeParse(blob.slice(0, WRAPPED_KEY_OFFSET).buffer);
  if (!header.success) {
    // A wrong magic also fails the version check; the first issue is the cause.
    if (header.error.issues[0]?.message === "INVALID_VERSION_BYTE")
      throw new DatabaseBlobError(
        "UNSUPPORTED_VERSION",
        `Unsupported database format version ${blob[VERSION_OFFSET]}`,
      );
    throw new DatabaseBlobError("INVALID_FORMAT", "Not a Spendy database");
  }
  if (blob.length < CIPHERTEXT_OFFSET + TAG_LENGTH)
    throw new DatabaseBlobError("INVALID_FORMAT", "The database is truncated");

  let compressed;
  try {
    const dataKey = await crypto.subtle.unwrapKey(
      "raw",
      blob.subarray(WRAPPED_KEY_OFFSET, IV_OFFSET),
      kek,
      "AES-KW",
      "AES-GCM",
      false,
      ["decrypt"],
    );
    compressed = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: blob.subarray(IV_OFFSET, CIPHERTEXT_OFFSET) },
      dataKey,
      blob.subarray(CIPHERTEXT_OFFSET),
    );
  } catch {
    // A wrong KEK fails the unwrap; any modified byte fails it or the GCM tag.
    throw new DatabaseBlobError("DECRYPTION_FAILED", "Couldn't decrypt the database");
  }

  return transform(new Uint8Array(compressed), new DecompressionStream("gzip"));
}

async function transform(
  bytes: Uint8Array<ArrayBuffer>,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array<ArrayBuffer>> {
  const output = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(output).arrayBuffer());
}
