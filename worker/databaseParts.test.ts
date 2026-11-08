import { describe, expect, it } from "vitest";
import {
  MIN_PART_LENGTH,
  NO_PREVIOUS_PART,
  partChainError,
  readParts,
  sha256Hex,
} from "./databaseParts.ts";
import { chainedParts, concatBytes, databasePart } from "./test/helpers.ts";

/** Copied into a Uint8Array<ArrayBuffer>, as sha256Hex takes: TextEncoder's type allows any buffer. */
const encode = (text: string) => new Uint8Array(new TextEncoder().encode(text));

/**
 * A part written out byte by byte, so the layout is checked against the
 * format rather than against the module's own offsets.
 */
function handWrittenPart({
  length = [0x74, 0x00, 0x00, 0x00],
  userVersion = [0x04, 0x03, 0x02, 0x01],
} = {}) {
  return new Uint8Array([
    ...encode("SPENDY"),
    0x02,
    ...length,
    ...Array<number>(40).fill(0xaa), // wrapped key
    ...Array.from({ length: 32 }, (_, i) => i), // previous part's sha256
    ...userVersion,
    ...Array<number>(12).fill(0xbb), // nonce
    0xcc, // ciphertext
    ...Array<number>(16).fill(0xdd), // tag
  ]);
}

describe("sha256Hex", () => {
  it("is the sha256 in lowercase hex", async () => {
    expect(await sha256Hex(encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("readParts", () => {
  it("reads a part's header, with little-endian integers, and hashes the part", async () => {
    const part = handWrittenPart();

    expect(await readParts(part)).toEqual({
      success: true,
      parts: [
        {
          bytes: part,
          hash: await sha256Hex(part),
          previousHash: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
          userVersion: 0x01020304,
        },
      ],
    });
  });

  it("reads the user version as unsigned", async () => {
    const result = await readParts(handWrittenPart({ userVersion: [0, 0, 0, 0x80] }));

    expect(result).toMatchObject({ success: true, parts: [{ userVersion: 2 ** 31 }] });
  });

  it("splits parts one after the other by their lengths", async () => {
    const parts = await chainedParts({ size: MIN_PART_LENGTH + 10 }, {}, { size: 300 });

    const result = await readParts(concatBytes(parts));

    if (!result.success) expect.unreachable(result.code);
    expect(result.parts.map(({ bytes }) => bytes)).toEqual(parts);
    expect(result.parts.map(({ hash }) => hash)).toEqual(
      await Promise.all(parts.map((part) => sha256Hex(part))),
    );
  });

  it("accepts a part of the minimum length, with an empty ciphertext", async () => {
    const part = databasePart(NO_PREVIOUS_PART, { size: MIN_PART_LENGTH });

    expect(await readParts(part)).toMatchObject({ success: true, parts: [{ bytes: part }] });
  });

  const part = handWrittenPart();
  it.each([
    ["no bytes", new Uint8Array(), "MISSING_SPENDY_MAGIC"],
    ["another magic", encode("SQLITE\x02"), "MISSING_SPENDY_MAGIC"],
    ["part of the magic", encode("SPEN"), "MISSING_SPENDY_MAGIC"],
    ["only the magic", encode("SPENDY"), "INVALID_VERSION_BYTE"],
    ["version 1", part.with(6, 0x01), "INVALID_VERSION_BYTE"],
    ["a header that ends in its length", part.subarray(0, 9), "INVALID_PART_LENGTH"],
    [
      "a length shorter than a part can be",
      handWrittenPart({ length: [MIN_PART_LENGTH - 1, 0, 0, 0] }),
      "INVALID_PART_LENGTH",
    ],
    ["a length past the end", part.subarray(0, -1), "INVALID_PART_LENGTH"],
    [
      "a length with its top bit set",
      handWrittenPart({ length: [0x74, 0, 0, 0x80] }),
      "INVALID_PART_LENGTH",
    ],
    ["bytes after the last part", concatBytes([part, encode("x")]), "MISSING_SPENDY_MAGIC"],
    [
      "an invalid part after a valid one",
      concatBytes([part, part.with(6, 0x01)]),
      "INVALID_VERSION_BYTE",
    ],
  ])("rejects %s", async (_name, bytes, code) => {
    expect(await readParts(bytes)).toEqual({ success: false, code });
  });
});

describe("partChainError", () => {
  const previous = { hash: "a".repeat(64), userVersion: 3 };

  it("lets part 0 follow no part, by pointing at zeros", () => {
    expect(
      partChainError({ previousHash: NO_PREVIOUS_PART, userVersion: 1 }, undefined),
    ).toBeUndefined();
    expect(partChainError({ previousHash: previous.hash, userVersion: 1 }, undefined)).toBe(
      "BROKEN_PART_CHAIN",
    );
  });

  it("lets a part follow only the part whose hash it holds", () => {
    expect(
      partChainError({ previousHash: previous.hash, userVersion: 3 }, previous),
    ).toBeUndefined();
    expect(partChainError({ previousHash: "b".repeat(64), userVersion: 3 }, previous)).toBe(
      "BROKEN_PART_CHAIN",
    );
    expect(partChainError({ previousHash: NO_PREVIOUS_PART, userVersion: 3 }, previous)).toBe(
      "BROKEN_PART_CHAIN",
    );
  });

  it("lets the user version stay the same or go up, but not down", () => {
    const after = (userVersion: number) =>
      partChainError({ previousHash: previous.hash, userVersion }, previous);

    expect(after(3)).toBeUndefined();
    expect(after(4)).toBeUndefined();
    expect(after(2)).toBe("USER_VERSION_DECREASED");
  });
});
