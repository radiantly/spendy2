/**
 * The database is stored as a chain of parts, each encrypted on its own. Part
 * 0 is an SQLite database, and each part after it a changeset to apply on
 * top of the ones before it:
 *
 *   "SPENDY" | 0x02 | length (4) | wrapped data key (40) | AAD (36) | nonce (12) | ciphertext | tag (16)
 *
 * - The length is the whole part's, from the magic to the tag.
 * - The AAD is the sha256 of the part before it (zeros for part 0), then
 *   the user_version its content was written at. It's AES-GCM's additional
 *   data, so it's authenticated but readable.
 * - The ciphertext is AES-GCM(gzip(sqlite file or changeset)).
 * - Integers are unsigned and little-endian.
 *
 * The server reads each header up to the AAD, and checks that the parts
 * chain; the rest is only read by clients, which write parts with partAad
 * and assemblePart (see src/db/parts.ts). Runs in the worker, the browser
 * and the scripts.
 */

export const PART_FORMAT = `
\`\`\`
                                                                   AES-GCM(gzip(content))
                                                       ---------------------------------------------
"SPENDY" | 0x02 | length (4) | wrapped data key (40) | AAD (36) | nonce (12) | ciphertext | tag (16)
                     \\                                      \\
                      \\                                     SHA256 of previous part (32) | DB user_version (4)                   
                       \\
                       Length of this part in bytes, little-endian
\`\`\``;

export const PART_MAGIC = new TextEncoder().encode("SPENDY");
export const PART_VERSION = 0x02;

export const VERSION_OFFSET = PART_MAGIC.length;
export const LENGTH_OFFSET = VERSION_OFFSET + 1;
export const WRAPPED_KEY_OFFSET = LENGTH_OFFSET + 4;
/** AES-KW output for a 256-bit key: the key plus an 8-byte integrity block. */
export const WRAPPED_KEY_LENGTH = 40;
export const AAD_OFFSET = WRAPPED_KEY_OFFSET + WRAPPED_KEY_LENGTH;
const SHA256_LENGTH = 32;
export const USER_VERSION_OFFSET = AAD_OFFSET + SHA256_LENGTH;
export const AAD_LENGTH = SHA256_LENGTH + 4;
export const NONCE_OFFSET = AAD_OFFSET + AAD_LENGTH;
export const NONCE_LENGTH = 12;
export const CIPHERTEXT_OFFSET = NONCE_OFFSET + NONCE_LENGTH;
export const TAG_LENGTH = 16;
/** A part with an empty ciphertext: only its header and tag. */
export const MIN_PART_LENGTH = CIPHERTEXT_OFFSET + TAG_LENGTH;

/** What part 0's AAD holds in place of a previous part's sha256. */
export const NO_PREVIOUS_PART = "0".repeat(2 * SHA256_LENGTH);

export interface DatabasePart {
  /** The whole part, from the magic to the tag. */
  bytes: Uint8Array<ArrayBuffer>;
  /** The part's sha256, in hex. */
  hash: string;
  /** The sha256 of the part before it, in hex, from the AAD. */
  previousHash: string;
  /** The user_version its content was written at, from the AAD. */
  userVersion: number;
}

export type PartFormatError =
  | "MISSING_SPENDY_MAGIC"
  | "INVALID_VERSION_BYTE"
  | "INVALID_PART_LENGTH";

export type PartChainError = "BROKEN_PART_CHAIN" | "USER_VERSION_DECREASED";

/** The parts `bytes` holds one after the other, of which there must be at least one. */
export async function readParts(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<{ success: true; parts: DatabasePart[] } | { success: false; code: PartFormatError }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headers: Omit<DatabasePart, "hash">[] = [];

  let offset = 0;
  do {
    const rest = bytes.subarray(offset);
    if (!PART_MAGIC.every((byte, i) => byte === rest[i]))
      return { success: false, code: "MISSING_SPENDY_MAGIC" };
    if (rest[VERSION_OFFSET] !== PART_VERSION)
      return { success: false, code: "INVALID_VERSION_BYTE" };
    // the length itself is cut off
    if (rest.length < WRAPPED_KEY_OFFSET) return { success: false, code: "INVALID_PART_LENGTH" };

    const length = view.getUint32(offset + LENGTH_OFFSET, true);
    if (length < MIN_PART_LENGTH || length > rest.length)
      return { success: false, code: "INVALID_PART_LENGTH" };

    const part = rest.subarray(0, length);
    headers.push({
      bytes: part,
      previousHash: toHex(part.subarray(AAD_OFFSET, USER_VERSION_OFFSET)),
      userVersion: view.getUint32(offset + USER_VERSION_OFFSET, true),
    });
    offset += length;
  } while (offset < bytes.length);

  const hashes = await Promise.all(headers.map(({ bytes }) => sha256Hex(bytes)));
  return {
    success: true,
    parts: headers.map((header, i) => ({ ...header, hash: hashes[i]! })),
  };
}

/**
 * Why `part` can't come right after `previous`, or undefined if it can. Part
 * 0 comes after no part.
 */
export function partChainError(
  part: Pick<DatabasePart, "previousHash" | "userVersion">,
  previous: Pick<DatabasePart, "hash" | "userVersion"> | undefined,
): PartChainError | undefined {
  if (part.previousHash !== (previous?.hash ?? NO_PREVIOUS_PART)) return "BROKEN_PART_CHAIN";
  if (previous !== undefined && part.userVersion < previous.userVersion)
    return "USER_VERSION_DECREASED";
  return undefined;
}

/**
 * A part's AAD: the sha256 of the part before it (NO_PREVIOUS_PART for
 * part 0), in hex, and the user_version its content was written at.
 */
export function partAad(previousHash: string, userVersion: number) {
  if (!/^[0-9a-f]{64}$/.test(previousHash)) throw new Error(`Not a sha256: ${previousHash}`);
  const aad = new Uint8Array(AAD_LENGTH);
  aad.set(fromHex(previousHash));
  new DataView(aad.buffer).setUint32(SHA256_LENGTH, userVersion, true);
  return aad;
}

/** A part from what goes in it; `aad` from `partAad`, `ciphertext` with its tag. */
export function assemblePart({
  wrappedKey,
  aad,
  nonce,
  ciphertext,
}: {
  wrappedKey: Uint8Array;
  aad: Uint8Array;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}) {
  const part = new Uint8Array(CIPHERTEXT_OFFSET + ciphertext.length);
  part.set(PART_MAGIC);
  part[VERSION_OFFSET] = PART_VERSION;
  new DataView(part.buffer).setUint32(LENGTH_OFFSET, part.length, true);
  part.set(wrappedKey, WRAPPED_KEY_OFFSET);
  part.set(aad, AAD_OFFSET);
  part.set(nonce, NONCE_OFFSET);
  part.set(ciphertext, CIPHERTEXT_OFFSET);
  return part;
}

/** The sha256 of `bytes`, in hex. */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>) {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string) {
  return Uint8Array.from(hex.match(/../g) ?? [], (byte) => parseInt(byte, 16));
}
