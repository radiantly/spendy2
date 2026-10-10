import { reset } from "cloudflare:test";
import * as opaque from "@serenity-kit/opaque";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { forwardFetchToWorker, loginToken, registerUser } from "../../worker/test/helpers.ts";
import { installFakeS3 } from "../../worker/test/fake-s3.ts";
import { toSha256Schema } from "../../worker/schemas.ts";
import { downloadDatabase, uploadDatabase } from "./database.ts";
import { TOKEN } from "../test/fixtures.ts";

let token: string;
/** Well-formed, but for a session alice never had. */
const UNKNOWN_SESSION = TOKEN;

beforeAll(() => opaque.ready);
beforeEach(async () => {
  // The fake S3 first: forwardFetchToWorker passes the S3 requests on to it.
  installFakeS3();
  forwardFetchToWorker();
  await registerUser("alice");
  token = await loginToken("alice");
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await reset();
});

/** The server only checks the SPENDY magic and version byte. */
function blob(content: string) {
  const encoder = new TextEncoder();
  return new Uint8Array([...encoder.encode("SPENDY"), 1, ...encoder.encode(content)]);
}

const sha256Of = (bytes: Uint8Array<ArrayBuffer>) =>
  toSha256Schema.decodeAsync(bytes.slice().buffer);

describe("downloadDatabase", () => {
  it("reports a user without a database as not found", async () => {
    expect(await downloadDatabase(token)).toEqual({ success: false, code: "NOT_FOUND" });
  });

  it("returns the uploaded blob and its sha256", async () => {
    const body = blob("first");
    await uploadDatabase(token, body.slice(), { ifNoneMatch: true });

    expect(await downloadDatabase(token)).toEqual({
      success: true,
      blob: body,
      sha256: await sha256Of(body),
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

describe("uploadDatabase", () => {
  it("returns the sha256 of the stored blob", async () => {
    const body = blob("first");

    expect(await uploadDatabase(token, body.slice(), { ifNoneMatch: true })).toEqual({
      success: true,
      sha256: await sha256Of(body),
    });
  });

  it("replaces the version it names", async () => {
    const first = await uploadDatabase(token, blob("first"), { ifNoneMatch: true });
    if (!first.success) expect.unreachable();

    const second = await uploadDatabase(token, blob("second"), { ifMatch: first.sha256 });

    expect(second).toEqual({ success: true, sha256: await sha256Of(blob("second")) });
  });

  it("reports a stale version as a conflict", async () => {
    const first = await uploadDatabase(token, blob("first"), { ifNoneMatch: true });
    if (!first.success) expect.unreachable();
    await uploadDatabase(token, blob("second"), { ifMatch: first.sha256 });

    expect(await uploadDatabase(token, blob("third"), { ifMatch: first.sha256 })).toEqual({
      success: false,
      code: "CONFLICT",
    });
  });

  it("reports a first upload over an existing database as a conflict", async () => {
    await uploadDatabase(token, blob("first"), { ifNoneMatch: true });

    expect(await uploadDatabase(token, blob("other device"), { ifNoneMatch: true })).toEqual({
      success: false,
      code: "CONFLICT",
    });
  });

  it("reports an unknown session as unauthorized", async () => {
    expect(await uploadDatabase(UNKNOWN_SESSION, blob("first"), { ifNoneMatch: true })).toEqual({
      success: false,
      code: "UNAUTHORIZED",
    });
  });

  it("reports a rejected blob as a generic failure", async () => {
    const notSpendy = new Uint8Array(new TextEncoder().encode("plain sqlite file"));

    expect(await uploadDatabase(token, notSpendy, { ifNoneMatch: true })).toEqual({
      success: false,
      code: "UPLOAD_FAILED",
    });
  });

  it("throws when the server can't be reached", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));

    await expect(uploadDatabase(token, blob("first"), { ifNoneMatch: true })).rejects.toThrow(
      "Failed to fetch",
    );
  });
});
