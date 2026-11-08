import { describe, expect, it } from "vitest";
import {
  AAD_OFFSET,
  CIPHERTEXT_OFFSET,
  NO_PREVIOUS_PART,
  NONCE_OFFSET,
  USER_VERSION_OFFSET,
  VERSION_OFFSET,
  WRAPPED_KEY_OFFSET,
  readParts,
  sha256Hex,
} from "../../worker/databaseParts.ts";
import { deriveKek } from "../lib/kek.ts";
import { EXPORT_KEY } from "../test/fixtures.ts";
import { DatabasePartError, decryptPart, encryptPart, readChain } from "./parts.ts";

/**
 * Independent test vector, built with Node's crypto and zlib: the KEK from
 * EXPORT_KEY wrapping data key 0xa0..0xbf (see kek.test.ts), nonce
 * 0xc0..0xcb, previous part's sha256 0x10..0x2f, user version 7, plaintext
 * "spendy part test vector".
 *
 * If this test fails, the part format changed and every stored database
 * (including ones the scripts wrote) can no longer be read.
 */
const VECTOR = {
  part: hexToBytes(
    "5350454e4459029e000000e72bda67d5274f85f740d9de73464d16762ff72e0ecdfbb9e690e429dcdebafcd7f6" +
      "44f7ae7b0b89101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f07000000c0c1c2c3" +
      "c4c5c6c7c8c9cacb53eb33f33ec0e285ee4cb8e2b9a95f0ca4e44b296e5246c05b762594a13421295d362f05ea18" +
      "95087c7800fe6786bc5ce58ba9b5fdfc5a5bc44760",
  ),
  previousHash: "101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f",
  userVersion: 7,
  plaintext: "spendy part test vector",
};

function hexToBytes(hex: string) {
  return Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16));
}

/** Copied into a Uint8Array<ArrayBuffer>: TextEncoder's type allows any buffer. */
const encode = (text: string) => new Uint8Array(new TextEncoder().encode(text));
const kek = () => deriveKek(EXPORT_KEY);
const otherKek = () => deriveKek("b3RoZXIgZXhwb3J0IGtleQ");

const AFTER_NOTHING = { previousHash: NO_PREVIOUS_PART, userVersion: 1 };

async function rejection(promise: Promise<unknown>) {
  return promise.then(
    () => expect.unreachable("expected a rejection"),
    (error: unknown) => error,
  );
}

async function expectPartError(promise: Promise<unknown>, code: DatabasePartError["code"]) {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(DatabasePartError);
  expect((error as DatabasePartError).code).toBe(code);
}

function flipByte(bytes: Uint8Array<ArrayBuffer>, index: number) {
  const copy = bytes.slice();
  copy[index]! ^= 0x01;
  return copy;
}

/** `bytes` read as the one part they are. */
async function onlyPart(bytes: Uint8Array<ArrayBuffer>) {
  const read = await readParts(bytes);
  if (!read.success || read.parts.length !== 1) expect.unreachable(JSON.stringify(read));
  return read.parts[0]!;
}

/** Parts that chain from part 0, holding `contents`. */
async function chainOf(...contents: string[]) {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  for (const content of contents) {
    const previous = parts.at(-1);
    parts.push(
      await encryptPart(encode(content), await kek(), {
        previousHash: previous === undefined ? NO_PREVIOUS_PART : await sha256Hex(previous),
        userVersion: 1,
      }),
    );
  }
  return parts;
}

function concat(parts: Uint8Array<ArrayBuffer>[]) {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

describe("encryptPart / decryptPart", () => {
  it("decrypts the pinned test vector", async () => {
    const part = await onlyPart(VECTOR.part);

    expect(part).toMatchObject({
      previousHash: VECTOR.previousHash,
      userVersion: VECTOR.userVersion,
    });
    expect(new TextDecoder().decode(await decryptPart(part, await kek()))).toBe(VECTOR.plaintext);
  });

  it("round-trips, with the previous part's hash and the user version in the AAD", async () => {
    const bytes = encode("a sqlite file, more or less");
    const previousHash = "ab".repeat(32);

    const encrypted = await encryptPart(bytes, await kek(), { previousHash, userVersion: 3 });

    const part = await onlyPart(encrypted);
    expect(part).toMatchObject({ previousHash, userVersion: 3 });
    expect(await decryptPart(part, await kek())).toEqual(bytes);
  });

  it("round-trips an empty input", async () => {
    const encrypted = await encryptPart(new Uint8Array(), await kek(), AFTER_NOTHING);

    expect(await decryptPart(await onlyPart(encrypted), await kek())).toEqual(new Uint8Array());
  });

  it("writes the SPENDY header with version 2", async () => {
    const part = await encryptPart(encode("x"), await kek(), AFTER_NOTHING);

    expect(new TextDecoder().decode(part.subarray(0, VERSION_OFFSET))).toBe("SPENDY");
    expect(part[VERSION_OFFSET]).toBe(2);
    expect([WRAPPED_KEY_OFFSET, AAD_OFFSET, NONCE_OFFSET, CIPHERTEXT_OFFSET]).toEqual([
      11, 51, 87, 99,
    ]);
  });

  it("uses a fresh data key and nonce every time", async () => {
    const bytes = encode("same input");

    const first = await encryptPart(bytes, await kek(), AFTER_NOTHING);
    const second = await encryptPart(bytes, await kek(), AFTER_NOTHING);

    expect(second.subarray(WRAPPED_KEY_OFFSET, AAD_OFFSET)).not.toEqual(
      first.subarray(WRAPPED_KEY_OFFSET, AAD_OFFSET),
    );
    expect(second.subarray(NONCE_OFFSET, CIPHERTEXT_OFFSET)).not.toEqual(
      first.subarray(NONCE_OFFSET, CIPHERTEXT_OFFSET),
    );
  });

  it("compresses before encrypting", async () => {
    const part = await encryptPart(new Uint8Array(100_000), await kek(), AFTER_NOTHING);

    expect(part.length).toBeLessThan(1_000);
  });

  it("rejects a different KEK", async () => {
    const part = await encryptPart(encode("secret"), await kek(), AFTER_NOTHING);

    await expectPartError(decryptPart(await onlyPart(part), await otherKek()), "DECRYPTION_FAILED");
  });

  it.each([
    ["wrapped key", WRAPPED_KEY_OFFSET],
    ["previous part's hash", AAD_OFFSET],
    ["user version", USER_VERSION_OFFSET],
    ["nonce", NONCE_OFFSET],
    ["ciphertext", CIPHERTEXT_OFFSET],
  ])("rejects a modified %s", async (_, index) => {
    const part = await encryptPart(encode("secret"), await kek(), AFTER_NOTHING);

    const modified = await onlyPart(flipByte(part, index));

    await expectPartError(decryptPart(modified, await kek()), "DECRYPTION_FAILED");
  });
});

describe("readChain", () => {
  it("reads parts that follow each other", async () => {
    const parts = await chainOf("database", "changes", "more changes");

    const read = await readChain(concat(parts));

    expect(read.map(({ bytes }) => bytes)).toEqual(parts);
  });

  it("rejects bytes that aren't parts", async () => {
    await expectPartError(readChain(encode("SQLite format 3")), "INVALID_FORMAT");
  });

  it("rejects a part of another version", async () => {
    const [part] = await chainOf("database");

    await expectPartError(readChain(part!.with(VERSION_OFFSET, 1)), "UNSUPPORTED_VERSION");
  });

  it.each([0, 3, CIPHERTEXT_OFFSET, CIPHERTEXT_OFFSET + 15])(
    "rejects a part cut off at %i bytes",
    async (length) => {
      const [part] = await chainOf("x");

      await expectPartError(readChain(part!.slice(0, length)), "INVALID_FORMAT");
    },
  );

  it("rejects a part 0 that follows another part", async () => {
    const part = await encryptPart(encode("database"), await kek(), {
      previousHash: "ab".repeat(32),
      userVersion: 1,
    });

    await expectPartError(readChain(part), "BROKEN_CHAIN");
  });

  it.each([
    ["out of order", (parts: Uint8Array<ArrayBuffer>[]) => parts.toReversed()],
    ["with one missing", (parts: Uint8Array<ArrayBuffer>[]) => [parts[0]!, parts[2]!]],
  ])("rejects parts %s", async (_name, change) => {
    const parts = await chainOf("database", "changes", "more changes");

    await expectPartError(readChain(concat(change(parts))), "BROKEN_CHAIN");
  });

  it("rejects a user version that goes down", async () => {
    const [first] = await chainOf("database");
    const lower = await encryptPart(encode("changes"), await kek(), {
      previousHash: await sha256Hex(first!),
      userVersion: 0,
    });

    await expectPartError(readChain(concat([first!, lower])), "BROKEN_CHAIN");
  });
});
