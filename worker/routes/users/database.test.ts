import { env, exports } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import * as opaque from "@serenity-kit/opaque";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { toSha256Schema } from "../../schemas.ts";
import { loginToken, registerUser } from "../../test/helpers.ts";

beforeAll(() => opaque.ready);
afterEach(() => reset());

/** A blob in the SPENDY format with the given content after the header. */
function databaseBlob(content: string, version = 1) {
  const encoder = new TextEncoder();
  return new Uint8Array([...encoder.encode("SPENDY"), version, ...encoder.encode(content)]);
}

/**
 * A database of `size` bytes whose content differs all along it, so parts
 * of it stored out of order would show.
 */
function largeDatabaseBlob(size: number) {
  const bytes = Uint8Array.from({ length: size }, (_, i) => i % 251);
  bytes.set(databaseBlob(""));
  return bytes;
}

async function etagOf(bytes: Uint8Array) {
  return `"${await toSha256Schema.decodeAsync(bytes.slice().buffer)}"`;
}

function putDatabase(
  token: string | undefined,
  body: Uint8Array | ReadableStream<Uint8Array>,
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

function getDatabase(token: string | undefined, headers: Record<string, string> = {}) {
  return exports.default.fetch("http://localhost/api/users/me/database", {
    headers: {
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      ...headers,
    },
  });
}

async function newUser(username = "alice") {
  await registerUser(username);
  return loginToken(username);
}

/** The stored database's ETag and content, or the status if there's none to download. */
async function downloaded(token: string) {
  const response = await getDatabase(token);
  if (response.status !== 200) return response.status;
  return {
    etag: response.headers.get("ETag"),
    body: new Uint8Array(await response.arrayBuffer()),
  };
}

/**
 * Like `downloaded`, with the content's hash (as an ETag) instead of the
 * content, for databases too large to compare: a failing toEqual would print
 * megabytes.
 */
async function downloadedHashes(token: string) {
  const stored = await downloaded(token);
  if (typeof stored !== "object") return stored;
  return { etag: stored.etag, contentEtag: await etagOf(stored.body) };
}

/** Uploads the first database and returns its ETag. */
async function firstUpload(token: string, body: Uint8Array) {
  const response = await putDatabase(token, body, { "If-None-Match": "*" });
  expect(response.status).toBe(204);
  return response.headers.get("ETag")!;
}

describe("PUT /api/users/me/database", () => {
  it("requires authentication", async () => {
    const token = await newUser();

    const response = await putDatabase(undefined, databaseBlob("v1"), {
      "If-None-Match": "*",
    });

    expect(response.status).toBe(401);
    expect(await downloaded(token)).toBe(404);
  });

  it("stores the first database", async () => {
    const token = await newUser();
    const body = databaseBlob("v1");

    const etag = await firstUpload(token, body);

    expect(etag).toBe(await etagOf(body));
    expect(await downloaded(token)).toEqual({ etag, body });
  });

  it("reports how long receiving and storing the upload took", async () => {
    const token = await newUser();

    const response = await putDatabase(token, databaseBlob("v1"), { "If-None-Match": "*" });

    const metrics = response.headers.get("Server-Timing")?.split(",") ?? [];
    expect(metrics.map((metric) => /^(\w+);dur=[\d.]+(;|$)/.exec(metric)?.[1])).toEqual([
      "store",
      "total",
    ]);
  });

  it("replaces the database when If-Match is current", async () => {
    const token = await newUser();
    const etag = await firstUpload(token, databaseBlob("v1"));
    const body = databaseBlob("v2");

    const response = await putDatabase(token, body, { "If-Match": etag });

    expect(response.status).toBe(204);
    expect(response.headers.get("ETag")).toBe(await etagOf(body));
    expect(await downloaded(token)).toEqual({ etag: await etagOf(body), body });
  });

  describe("preconditions", () => {
    it("rejects an upload without a conditional header", async () => {
      const token = await newUser();

      const response = await putDatabase(token, databaseBlob("v1"));

      expect(response.status).toBe(400);
      expect(await downloaded(token)).toBe(404);
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
      const etag = await firstUpload(token, databaseBlob("v1"));

      const response = await putDatabase(token, databaseBlob("v2"), {
        "If-None-Match": "*",
      });

      expect(response.status).toBe(412);
      expect(await response.json()).toEqual({ error: "PRECONDITION_FAILED" });
      expect(await downloaded(token)).toEqual({ etag, body: databaseBlob("v1") });
    });

    it("rejects a stale If-Match", async () => {
      const token = await newUser();
      const stale = await firstUpload(token, databaseBlob("v1"));
      await putDatabase(token, databaseBlob("v2"), { "If-Match": stale });

      const response = await putDatabase(token, databaseBlob("v3"), {
        "If-Match": stale,
      });

      expect(response.status).toBe(412);
      expect(await downloaded(token)).toMatchObject({ body: databaseBlob("v2") });
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
      ["an empty body", new Uint8Array(), "MISSING_SPENDY_MAGIC"],
      ["only the magic", new TextEncoder().encode("SPENDY"), "INVALID_VERSION_BYTE"],
      ["the wrong magic", new TextEncoder().encode("SQLITE\x01data"), "MISSING_SPENDY_MAGIC"],
      ["an unsupported version", databaseBlob("v1", 2), "INVALID_VERSION_BYTE"],
    ])("rejects %s", async (_name, body, error) => {
      const token = await newUser();

      const response = await putDatabase(token, body, { "If-None-Match": "*" });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error });
      expect(await downloaded(token)).toBe(404);
    });

    it("rejects an upload that doesn't say how long it is", async () => {
      const token = await newUser();
      // the runtime knows the length of other streams, like a Response's body
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(databaseBlob("v1"));
          controller.close();
        },
      });

      const response = await putDatabase(token, stream, { "If-None-Match": "*" });

      expect(response.status).toBe(400);
      expect(await downloaded(token)).toBe(404);
    });

    it("stores a database of exactly the maximum size byte for byte", async () => {
      const token = await newUser();
      const body = largeDatabaseBlob(env.MAX_DATABASE_UPLOAD_BYTES);

      const response = await putDatabase(token, body, { "If-None-Match": "*" });

      expect(response.status).toBe(204);
      const etag = await etagOf(body);
      expect(await downloadedHashes(token)).toEqual({ etag, contentEtag: etag });
    });

    it("replaces a larger database with a smaller one entirely", async () => {
      const token = await newUser();
      const etag = await firstUpload(token, largeDatabaseBlob(3 * 1024 * 1024));
      const body = databaseBlob("small");

      await putDatabase(token, body, { "If-Match": etag });

      const replaced = await etagOf(body);
      expect(await downloadedHashes(token)).toEqual({ etag: replaced, contentEtag: replaced });
    });

    it("rejects a database over the maximum size", async () => {
      const token = await newUser();
      const body = largeDatabaseBlob(env.MAX_DATABASE_UPLOAD_BYTES + 1);

      const response = await putDatabase(token, body, { "If-None-Match": "*" });

      expect(response.status).toBe(413);
      expect(await response.text()).toBe("Payload Too Large");
      expect(await downloaded(token)).toBe(404);
    });
  });

  it("lets only one of two concurrent uploads with the same If-Match win", async () => {
    const token = await newUser();
    const etag = await firstUpload(token, databaseBlob("v1"));
    const bodies = [databaseBlob("first"), databaseBlob("second")];

    const responses = await Promise.all(
      bodies.map((body) => putDatabase(token, body, { "If-Match": etag })),
    );

    const statuses = responses.map(({ status }) => status);
    expect(statuses.toSorted()).toEqual([204, 412]);
    const winner = bodies[statuses.indexOf(204)]!;
    expect(await downloaded(token)).toEqual({ etag: await etagOf(winner), body: winner });
  });

  it("checks If-Match once an upload has arrived, against any stored meanwhile", async () => {
    const token = await newUser();
    const etag = await firstUpload(token, databaseBlob("v1"));
    const slow = databaseBlob("slow");
    // a stream with a length, so it's let through, sent in two parts
    const { readable, writable } = new FixedLengthStream(slow.byteLength);
    const writer = writable.getWriter();

    const slowUpload = putDatabase(token, readable, { "If-Match": etag });
    await writer.write(slow.subarray(0, 4));
    // give the slow upload every chance to reach the user store
    await new Promise((resolve) => setTimeout(resolve, 100));
    const fast = databaseBlob("fast");
    const fastUpload = await putDatabase(token, fast, { "If-Match": etag });
    await writer.write(slow.subarray(4));
    await writer.close();

    expect(fastUpload.status).toBe(204);
    expect((await slowUpload).status).toBe(412);
    expect(await downloaded(token)).toEqual({ etag: await etagOf(fast), body: fast });
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

  describe("If-None-Match", () => {
    it("returns 304 for the current version", async () => {
      const token = await newUser();
      const etag = await firstUpload(token, databaseBlob("v1"));

      const response = await getDatabase(token, { "If-None-Match": etag });

      expect(response.status).toBe(304);
      expect(response.headers.get("ETag")).toBe(etag);
      expect(await response.arrayBuffer()).toHaveProperty("byteLength", 0);
    });

    it("returns the database when it has changed since", async () => {
      const token = await newUser();
      const old = await firstUpload(token, databaseBlob("v1"));
      const body = databaseBlob("v2");
      const etag = (await putDatabase(token, body, { "If-Match": old })).headers.get("ETag");

      const response = await getDatabase(token, { "If-None-Match": old });

      expect(response.status).toBe(200);
      expect(response.headers.get("ETag")).toBe(etag);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
    });

    it("returns 404 when there's no database", async () => {
      const token = await newUser();

      const response = await getDatabase(token, { "If-None-Match": `"${"a".repeat(64)}"` });

      expect(response.status).toBe(404);
    });

    it("requires authentication", async () => {
      const token = await newUser();
      const etag = await firstUpload(token, databaseBlob("v1"));

      expect((await getDatabase(undefined, { "If-None-Match": etag })).status).toBe(401);
    });

    it.each(["*", 'W/"abc"', `"${"a".repeat(64)}", "${"b".repeat(64)}"`])(
      "rejects an If-None-Match it doesn't support: %s",
      async (header) => {
        const token = await newUser();
        await firstUpload(token, databaseBlob("v1"));

        expect((await getDatabase(token, { "If-None-Match": header })).status).toBe(400);
      },
    );
  });
});
