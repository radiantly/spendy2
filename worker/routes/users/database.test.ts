import { env, exports } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import * as opaque from "@serenity-kit/opaque";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { toSha256Schema } from "../../schemas.ts";
import { installFakeS3 } from "../../test/fake-s3.ts";
import { loginToken, registerUser } from "../../test/helpers.ts";

let s3: ReturnType<typeof installFakeS3>;

beforeAll(() => opaque.ready);
beforeEach(() => {
  s3 = installFakeS3();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

/** A blob in the SPENDY format with the given content after the header. */
function databaseBlob(content: string, version = 1) {
  const encoder = new TextEncoder();
  return new Uint8Array([...encoder.encode("SPENDY"), version, ...encoder.encode(content)]);
}

async function etagOf(bytes: Uint8Array) {
  return `"${await toSha256Schema.decodeAsync(bytes.slice().buffer)}"`;
}

function putDatabase(
  token: string | undefined,
  body: Uint8Array,
  headers: Record<string, string> = {},
) {
  return exports.default.fetch("http://localhost/api/users/me/database", {
    method: "PUT",
    headers: {
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      ...headers,
    },
    body,
  });
}

function getDatabase(token: string | undefined) {
  return exports.default.fetch("http://localhost/api/users/me/database", {
    headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
  });
}

async function newUser(username = "alice") {
  await registerUser(username);
  return loginToken(username);
}

/** Uploads the first database and returns its ETag. */
async function firstUpload(token: string, body: Uint8Array) {
  const response = await putDatabase(token, body, { "If-None-Match": "*" });
  expect(response.status).toBe(204);
  return response.headers.get("ETag")!;
}

describe("PUT /api/users/me/database", () => {
  it("requires authentication", async () => {
    const response = await putDatabase(undefined, databaseBlob("v1"), {
      "If-None-Match": "*",
    });
    expect(response.status).toBe(401);
    expect(s3.putCount).toBe(0);
  });

  it("stores the first database", async () => {
    const token = await newUser();
    const body = databaseBlob("v1");

    const etag = await firstUpload(token, body);

    expect(etag).toBe(await etagOf(body));
    const stored = s3.objects.get("alice.db.gz.enc");
    expect(stored?.body).toEqual(body);
    expect(stored?.metadata["x-amz-meta-sha256"]).toBe(etag.slice(1, -1));
  });

  it("replaces the database when If-Match is current", async () => {
    const token = await newUser();
    const etag = await firstUpload(token, databaseBlob("v1"));
    const body = databaseBlob("v2");

    const response = await putDatabase(token, body, { "If-Match": etag });

    expect(response.status).toBe(204);
    expect(response.headers.get("ETag")).toBe(await etagOf(body));
    expect(s3.objects.get("alice.db.gz.enc")?.body).toEqual(body);
  });

  describe("preconditions", () => {
    it("rejects an upload without a conditional header", async () => {
      const token = await newUser();

      const response = await putDatabase(token, databaseBlob("v1"));

      expect(response.status).toBe(400);
      expect(s3.putCount).toBe(0);
    });

    it.each([
      ["both headers", { "If-Match": `"${"0".repeat(64)}"`, "If-None-Match": "*" }],
      ["a weak If-Match", { "If-Match": `W/"${"0".repeat(64)}"` }],
      ["an unquoted If-Match", { "If-Match": "0".repeat(64) }],
      ["an If-Match list", { "If-Match": `"${"0".repeat(64)}", "${"1".repeat(64)}"` }],
      ["an If-None-Match other than *", { "If-None-Match": `"${"0".repeat(64)}"` }],
    ])("rejects %s", async (_name, headers) => {
      const token = await newUser();

      const response = await putDatabase(token, databaseBlob("v1"), headers);

      expect(response.status).toBe(400);
    });

    it("rejects If-None-Match: * when a database exists", async () => {
      const token = await newUser();
      await firstUpload(token, databaseBlob("v1"));

      const response = await putDatabase(token, databaseBlob("v2"), {
        "If-None-Match": "*",
      });

      expect(response.status).toBe(412);
      expect(await response.json()).toEqual({ error: "PRECONDITION_FAILED" });
      expect(s3.putCount).toBe(1);
    });

    it("rejects a stale If-Match", async () => {
      const token = await newUser();
      const stale = await firstUpload(token, databaseBlob("v1"));
      await putDatabase(token, databaseBlob("v2"), { "If-Match": stale });

      const response = await putDatabase(token, databaseBlob("v3"), {
        "If-Match": stale,
      });

      expect(response.status).toBe(412);
      expect(s3.objects.get("alice.db.gz.enc")?.body).toEqual(databaseBlob("v2"));
    });

    it("rejects If-Match before the first upload", async () => {
      const token = await newUser();

      const response = await putDatabase(token, databaseBlob("v1"), {
        "If-Match": `"${"0".repeat(64)}"`,
      });

      expect(response.status).toBe(412);
    });
  });

  describe("body", () => {
    it.each([
      ["an empty body", new Uint8Array()],
      ["only the magic", new TextEncoder().encode("SPENDY")],
      ["the wrong magic", new TextEncoder().encode("SQLITE\x01data")],
      ["an unsupported version", databaseBlob("v1", 2)],
    ])("rejects %s", async (_name, body) => {
      const token = await newUser();

      const response = await putDatabase(token, body, { "If-None-Match": "*" });

      expect(response.status).toBe(400);
      expect(s3.putCount).toBe(0);
    });

    it("accepts a database of exactly the maximum size", async () => {
      const token = await newUser();
      const body = new Uint8Array(env.MAX_DATABASE_UPLOAD_BYTES);
      body.set(databaseBlob(""));

      const response = await putDatabase(token, body, { "If-None-Match": "*" });

      expect(response.status).toBe(204);
    });

    it("rejects a database over the maximum size", async () => {
      const token = await newUser();
      const body = new Uint8Array(env.MAX_DATABASE_UPLOAD_BYTES + 1);
      body.set(databaseBlob(""));

      const response = await putDatabase(token, body, { "If-None-Match": "*" });

      expect(response.status).toBe(413);
      expect(await response.text()).toBe("Payload Too Large");
      expect(s3.putCount).toBe(0);
    });
  });

  describe("object storage failures", () => {
    it("returns 502 and keeps the current version", async () => {
      const token = await newUser();
      const etag = await firstUpload(token, databaseBlob("v1"));
      s3.failRequests(503);

      const failed = await putDatabase(token, databaseBlob("v2"), {
        "If-Match": etag,
      });
      expect(failed.status).toBe(502);
      expect(await failed.json()).toEqual({ error: "STORAGE_ERROR" });

      s3.recover();
      const retried = await putDatabase(token, databaseBlob("v2"), {
        "If-Match": etag,
      });
      expect(retried.status).toBe(204);
    });
  });

  it("lets only one of two concurrent uploads with the same If-Match win", async () => {
    const token = await newUser();
    const etag = await firstUpload(token, databaseBlob("v1"));
    s3.holdPuts();

    const first = putDatabase(token, databaseBlob("first"), {
      "If-Match": etag,
    });
    await vi.waitUntil(() => s3.heldPutCount === 1);
    const second = putDatabase(token, databaseBlob("second"), {
      "If-Match": etag,
    });
    // give the second upload every chance to reach object storage
    await new Promise((resolve) => setTimeout(resolve, 100));
    s3.release();

    expect((await first).status).toBe(204);
    expect((await second).status).toBe(412);
    expect(s3.putCount).toBe(2);
    expect(s3.objects.get("alice.db.gz.enc")?.body).toEqual(databaseBlob("first"));
  });
});

describe("GET /api/users/me/database", () => {
  it("requires authentication", async () => {
    const response = await getDatabase(undefined);
    expect(response.status).toBe(401);
  });

  it("returns 404 before the first upload", async () => {
    const token = await newUser();

    const response = await getDatabase(token);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "NOT_FOUND" });
  });

  it("returns the latest database and its ETag", async () => {
    const token = await newUser();
    const body = databaseBlob("v1");
    const etag = await firstUpload(token, body);

    const response = await getDatabase(token);

    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBe(etag);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
  });

  it("only returns the user's own database", async () => {
    const alice = await newUser("alice");
    await firstUpload(alice, databaseBlob("alice"));
    const bob = await newUser("bob");

    expect((await getDatabase(bob)).status).toBe(404);
  });

  it("returns 502 when object storage fails", async () => {
    const token = await newUser();
    await firstUpload(token, databaseBlob("v1"));
    s3.failRequests(503);

    const response = await getDatabase(token);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "STORAGE_ERROR" });
  });

  it("adopts the version in object storage when the stored hash is behind", async () => {
    const token = await newUser();
    await firstUpload(token, databaseBlob("v1"));
    // an upload that reached object storage but whose hash was never stored
    const body = databaseBlob("v2");
    const sha256 = await toSha256Schema.decodeAsync(body.slice().buffer);
    s3.objects.set("alice.db.gz.enc", {
      body,
      metadata: { "x-amz-meta-sha256": sha256 },
    });

    const response = await getDatabase(token);
    expect(response.headers.get("ETag")).toBe(`"${sha256}"`);
    await response.arrayBuffer();

    const upload = await putDatabase(token, databaseBlob("v3"), {
      "If-Match": `"${sha256}"`,
    });
    expect(upload.status).toBe(204);
  });

  it("forgets the stored hash when the object is gone", async () => {
    const token = await newUser();
    await firstUpload(token, databaseBlob("v1"));
    s3.objects.clear();

    expect((await getDatabase(token)).status).toBe(404);

    const response = await putDatabase(token, databaseBlob("v2"), {
      "If-None-Match": "*",
    });
    expect(response.status).toBe(204);
  });
});
