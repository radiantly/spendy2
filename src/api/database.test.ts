import { reset } from "cloudflare:test";
import * as opaque from "@serenity-kit/opaque";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_PREVIOUS_PART, sha256Hex } from "../../workers/spendy2/databaseParts.ts";
import {
  chainedParts,
  concatBytes,
  databasePart,
  forwardFetchToWorker,
  loginToken,
  registerUser,
} from "../../workers/spendy2/test/helpers.ts";
import {
  appendDatabasePart,
  downloadDatabase,
  downloadDatabasePart,
  replaceDatabase,
} from "./database.ts";
import { TOKEN } from "../test/fixtures.ts";

let token: string;
/** Well-formed, but for a session alice never had. */
const UNKNOWN_SESSION = TOKEN;

beforeAll(() => opaque.ready);
beforeEach(async () => {
  forwardFetchToWorker();
  await registerUser("alice");
  token = await loginToken("alice");
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await reset();
});

/** A database of one part, `seed` telling it apart from others, stored as the first. */
async function firstStored(seed = 0) {
  const [part] = await chainedParts({ seed });
  expect(await replaceDatabase(token, part!, { ifNoneMatch: true })).toMatchObject({
    success: true,
  });
  return part!;
}

describe("downloadDatabase", () => {
  it("reports a user without a database as not found", async () => {
    expect(await downloadDatabase(token)).toEqual({ success: false, code: "NOT_FOUND" });
  });

  it("returns every part and the last one's sha256", async () => {
    const [first, second] = await chainedParts({}, {});
    await replaceDatabase(token, concatBytes([first!, second!]), { ifNoneMatch: true });

    expect(await downloadDatabase(token)).toEqual({
      success: true,
      parts: concatBytes([first!, second!]),
      sha256: await sha256Hex(second!),
    });
  });

  it("reports an unknown session as unauthorized", async () => {
    expect(await downloadDatabase(UNKNOWN_SESSION)).toEqual({
      success: false,
      code: "UNAUTHORIZED",
    });
  });

  it("throws when the server can't be reached", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));

    await expect(downloadDatabase(token)).rejects.toThrow("Failed to fetch");
  });
});

describe("downloadDatabasePart", () => {
  it("returns the part at an index, counting from 0, with its sha256", async () => {
    const first = await firstStored();
    const second = databasePart(await sha256Hex(first));
    await appendDatabasePart(token, second);

    expect(await downloadDatabasePart(token, 1)).toEqual({
      success: true,
      parts: second,
      sha256: await sha256Hex(second),
    });
  });

  it("reports a part past the last as not found", async () => {
    await firstStored();

    expect(await downloadDatabasePart(token, 1)).toEqual({ success: false, code: "NOT_FOUND" });
  });

  it("reports an unknown session as unauthorized", async () => {
    await firstStored();

    expect(await downloadDatabasePart(UNKNOWN_SESSION, 0)).toEqual({
      success: false,
      code: "UNAUTHORIZED",
    });
  });
});

describe("replaceDatabase", () => {
  it("returns the sha256 of the last part stored", async () => {
    const [part] = await chainedParts({});

    expect(await replaceDatabase(token, part!, { ifNoneMatch: true })).toEqual({
      success: true,
      sha256: await sha256Hex(part!),
    });
  });

  it("replaces the version it names", async () => {
    const first = await firstStored();
    const [second] = await chainedParts({ seed: 9 });

    expect(await replaceDatabase(token, second!, { ifMatch: await sha256Hex(first) })).toEqual({
      success: true,
      sha256: await sha256Hex(second!),
    });
  });

  it("reports a first upload over an existing database as a conflict", async () => {
    await firstStored();
    const [other] = await chainedParts({ seed: 9 });

    expect(await replaceDatabase(token, other!, { ifNoneMatch: true })).toEqual({
      success: false,
      code: "CONFLICT",
    });
  });

  it("reports a stale version as a conflict", async () => {
    const first = await firstStored();
    const [second] = await chainedParts({ seed: 9 });
    await replaceDatabase(token, second!, { ifMatch: await sha256Hex(first) });
    const [third] = await chainedParts({ seed: 18 });

    expect(await replaceDatabase(token, third!, { ifMatch: await sha256Hex(first) })).toEqual({
      success: false,
      code: "CONFLICT",
    });
  });

  it("reports an unknown session as unauthorized", async () => {
    const [part] = await chainedParts({});

    expect(await replaceDatabase(UNKNOWN_SESSION, part!, { ifNoneMatch: true })).toEqual({
      success: false,
      code: "UNAUTHORIZED",
    });
  });

  it("reports parts the server rejects as a failed upload", async () => {
    const part = databasePart("a".repeat(64));

    expect(await replaceDatabase(token, part, { ifNoneMatch: true })).toEqual({
      success: false,
      code: "UPLOAD_FAILED",
    });
  });

  it("throws when the server can't be reached", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));

    await expect(
      replaceDatabase(token, databasePart(NO_PREVIOUS_PART), { ifNoneMatch: true }),
    ).rejects.toThrow("Failed to fetch");
  });
});

describe("appendDatabasePart", () => {
  it("adds a part after the last one, returning its sha256", async () => {
    const first = await firstStored();
    const second = databasePart(await sha256Hex(first));

    expect(await appendDatabasePart(token, second)).toEqual({
      success: true,
      sha256: await sha256Hex(second),
    });
    expect(await downloadDatabase(token)).toMatchObject({ parts: concatBytes([first, second]) });
  });

  it("reports a part after one that's no longer the last as a conflict", async () => {
    const first = await firstStored();
    await appendDatabasePart(token, databasePart(await sha256Hex(first)));
    const late = databasePart(await sha256Hex(first), { seed: 9 });

    expect(await appendDatabasePart(token, late)).toEqual({
      success: false,
      code: "CONFLICT",
    });
  });

  it("reports adding to a database that isn't there as a conflict", async () => {
    expect(await appendDatabasePart(token, databasePart(NO_PREVIOUS_PART))).toEqual({
      success: false,
      code: "CONFLICT",
    });
  });

  it("reports an unknown session as unauthorized", async () => {
    const first = await firstStored();

    expect(await appendDatabasePart(UNKNOWN_SESSION, databasePart(await sha256Hex(first)))).toEqual(
      { success: false, code: "UNAUTHORIZED" },
    );
  });

  it("reports a part the server rejects as a failed upload", async () => {
    const first = await firstStored();
    // A format version the server doesn't read.
    const part = databasePart(await sha256Hex(first)).with(6, 0x01);

    expect(await appendDatabasePart(token, part)).toEqual({
      success: false,
      code: "UPLOAD_FAILED",
    });
  });
});
