/**
 * Encrypting and decrypting the parts the database is stored as; see
 * worker/databaseParts.ts for their format. Each part has a fresh AES-256-GCM
 * data key, wrapped with the KEK (AES-KW), and its AAD as AES-GCM's
 * additional data: the server reads the AAD to check the chain, and can't
 * change it without decrypting failing.
 *
 * The server is trusted with neither the parts' content nor their order, so
 * a chain is checked here too (see `readChain`).
 *
 * Runs in the browser and under Node, so the scripts can import it. The
 * format must stay stable: change it only by adding a new version.
 */

import {
  AAD_OFFSET,
  CIPHERTEXT_OFFSET,
  NONCE_LENGTH,
  NONCE_OFFSET,
  WRAPPED_KEY_OFFSET,
  assemblePart,
  partAad,
  partChainError,
  readParts,
  type DatabasePart,
} from "../../worker/databaseParts.ts";

export type DatabasePartErrorCode =
  | "INVALID_FORMAT"
  | "UNSUPPORTED_VERSION"
  | "BROKEN_CHAIN"
  | "DECRYPTION_FAILED";

export class DatabasePartError extends Error {
  override name = "DatabasePartError";
  readonly code: DatabasePartErrorCode;

  constructor(code: DatabasePartErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The parts `bytes` holds, one after the other, checked to chain from part
 * 0: each holds the hash of the one before it, and no user version is
 * lower than the one before it.
 */
export async function readChain(bytes: Uint8Array<ArrayBuffer>): Promise<DatabasePart[]> {
  const read = await readParts(bytes);
  if (!read.success) {
    if (read.code === "INVALID_VERSION_BYTE")
      throw new DatabasePartError("UNSUPPORTED_VERSION", "Unsupported database format version");
    throw new DatabasePartError("INVALID_FORMAT", "Not a Spendy database");
  }

  const { parts } = read;
  for (const [i, part] of parts.entries())
    if (partChainError(part, i === 0 ? undefined : parts[i - 1]) !== undefined)
      throw new DatabasePartError("BROKEN_CHAIN", `Part ${i} doesn't follow the part before it`);
  return parts;
}

/**
 * `content`, an SQLite file or a changeset, as a part after the one whose
 * sha256 is `previousHash` (NO_PREVIOUS_PART for part 0), written at
 * `userVersion`.
 */
export async function encryptPart(
  content: Uint8Array<ArrayBuffer>,
  kek: CryptoKey,
  { previousHash, userVersion }: { previousHash: string; userVersion: number },
): Promise<Uint8Array<ArrayBuffer>> {
  const compressed = await transform(content, new CompressionStream("gzip"));

  const dataKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
  ]);
  const wrappedKey = new Uint8Array(await crypto.subtle.wrapKey("raw", dataKey, kek, "AES-KW"));
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
  const aad = partAad(previousHash, userVersion);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad },
      dataKey,
      compressed,
    ),
  );

  return assemblePart({ wrappedKey, aad, nonce, ciphertext });
}

/** The content of `part`, a part `readChain` read. */
export async function decryptPart(
  { bytes }: DatabasePart,
  kek: CryptoKey,
): Promise<Uint8Array<ArrayBuffer>> {
  let compressed;
  try {
    const dataKey = await crypto.subtle.unwrapKey(
      "raw",
      bytes.subarray(WRAPPED_KEY_OFFSET, AAD_OFFSET),
      kek,
      "AES-KW",
      "AES-GCM",
      false,
      ["decrypt"],
    );
    compressed = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytes.subarray(NONCE_OFFSET, CIPHERTEXT_OFFSET),
        additionalData: bytes.subarray(AAD_OFFSET, NONCE_OFFSET),
      },
      dataKey,
      bytes.subarray(CIPHERTEXT_OFFSET),
    );
  } catch {
    // A wrong KEK fails the unwrap; any changed byte fails it or the GCM tag.
    throw new DatabasePartError("DECRYPTION_FAILED", "Couldn't decrypt the database");
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
