import { describe, expect, it } from "vitest";
import {
  CIPHERTEXT_OFFSET,
  DatabaseBlobError,
  IV_OFFSET,
  VERSION_OFFSET,
  WRAPPED_KEY_OFFSET,
  decryptDatabase,
  encryptDatabase,
} from "./blob.ts";
import { DATABASE_BLOB_MAGIC } from "../../worker/schemas.ts";
import { deriveKek } from "../lib/kek.ts";
import { EXPORT_KEY } from "../test/fixtures.ts";

/**
 * Independent test vector, built with Node's crypto and zlib: the KEK from
 * EXPORT_KEY wrapping data key 0xa0..0xbf (see kek.test.ts), iv 0xc0..0xcb,
 * plaintext "spendy blob test vector".
 *
 * If this test fails, the blob format changed and every stored database
 * (including ones the scripts wrote) can no longer be read.
 */
const VECTOR = {
  blob: hexToBytes(
    "5350454e445901e72bda67d5274f85f740d9de73464d16762ff72e0ecdfbb9e690e429dcdebafcd7f644f7ae7b0b89" +
      "c0c1c2c3c4c5c6c7c8c9cacb53eb33f33ec0e285ee4cb8e2b9a95f0ca484c9cc0b5146c05b762594a13421295d36" +
      "2fc4b63bcd087c780099ad69f8d2267bd1bc1842b3ff0d3807",
  ),
  plaintext: "spendy blob test vector",
};

function hexToBytes(hex: string) {
  return Uint8Array.from(hex.match(/../g)!, (byte) => parseInt(byte, 16));
}

const encode = (text: string) => new TextEncoder().encode(text);
const kek = () => deriveKek(EXPORT_KEY);
const otherKek = () => deriveKek("b3RoZXIgZXhwb3J0IGtleQ");

async function expectBlobError(promise: Promise<unknown>, code: DatabaseBlobError["code"]) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DatabaseBlobError);
  expect((error as DatabaseBlobError).code).toBe(code);
}

function flipByte(blob: Uint8Array<ArrayBuffer>, index: number) {
  const copy = blob.slice();
  copy[index]! ^= 0x01;
  return copy;
}

describe("encryptDatabase / decryptDatabase", () => {
  it("decrypts the pinned test vector", async () => {
    const bytes = await decryptDatabase(VECTOR.blob, await kek());

    expect(new TextDecoder().decode(bytes)).toBe(VECTOR.plaintext);
  });

  it("round-trips", async () => {
    const bytes = encode("a sqlite file, more or less");

    const blob = await encryptDatabase(bytes, await kek());

    expect(await decryptDatabase(blob, await kek())).toEqual(bytes);
  });

  it("round-trips an empty input", async () => {
    const blob = await encryptDatabase(new Uint8Array(), await kek());

    expect(await decryptDatabase(blob, await kek())).toEqual(new Uint8Array());
  });

  it("writes the SPENDY header with version 1", async () => {
    const blob = await encryptDatabase(encode("x"), await kek());

    expect(blob.subarray(0, VERSION_OFFSET)).toEqual(DATABASE_BLOB_MAGIC);
    expect(blob[VERSION_OFFSET]).toBe(1);
    expect([WRAPPED_KEY_OFFSET, IV_OFFSET, CIPHERTEXT_OFFSET]).toEqual([7, 47, 59]);
  });

  it("uses a fresh data key and iv every time", async () => {
    const bytes = encode("same input");

    const first = await encryptDatabase(bytes, await kek());
    const second = await encryptDatabase(bytes, await kek());

    expect(second.subarray(WRAPPED_KEY_OFFSET, IV_OFFSET)).not.toEqual(
      first.subarray(WRAPPED_KEY_OFFSET, IV_OFFSET),
    );
    expect(second.subarray(IV_OFFSET, CIPHERTEXT_OFFSET)).not.toEqual(
      first.subarray(IV_OFFSET, CIPHERTEXT_OFFSET),
    );
  });

  it("compresses before encrypting", async () => {
    const bytes = new Uint8Array(100_000);

    const blob = await encryptDatabase(bytes, await kek());

    expect(blob.length).toBeLessThan(1_000);
  });

  it("rejects a different KEK", async () => {
    const blob = await encryptDatabase(encode("secret"), await kek());

    await expectBlobError(decryptDatabase(blob, await otherKek()), "DECRYPTION_FAILED");
  });

  it.each([
    ["wrapped key", WRAPPED_KEY_OFFSET],
    ["iv", IV_OFFSET],
    ["ciphertext", CIPHERTEXT_OFFSET],
  ])("rejects a modified %s", async (_, index) => {
    const blob = await encryptDatabase(encode("secret"), await kek());

    await expectBlobError(decryptDatabase(flipByte(blob, index), await kek()), "DECRYPTION_FAILED");
  });

  it("rejects a blob without the magic", async () => {
    const blob = await encryptDatabase(encode("x"), await kek());

    await expectBlobError(decryptDatabase(flipByte(blob, 0), await kek()), "INVALID_FORMAT");
  });

  it("rejects an unknown version", async () => {
    const blob = await encryptDatabase(encode("x"), await kek());
    blob[VERSION_OFFSET] = 2;

    await expectBlobError(decryptDatabase(blob, await kek()), "UNSUPPORTED_VERSION");
  });

  it.each([0, 3, CIPHERTEXT_OFFSET, CIPHERTEXT_OFFSET + 15])(
    "rejects a blob truncated to %i bytes",
    async (length) => {
      const blob = await encryptDatabase(encode("x"), await kek());

      await expectBlobError(decryptDatabase(blob.slice(0, length), await kek()), "INVALID_FORMAT");
    },
  );
});
