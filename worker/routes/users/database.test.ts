import { exports } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import * as opaque from "@serenity-kit/opaque";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { NO_PREVIOUS_PART, sha256Hex } from "../../databaseParts.ts";
import {
  chainedParts,
  concatBytes,
  databasePart,
  loginToken,
  registerUser,
} from "../../test/helpers.ts";

beforeAll(() => opaque.ready);
afterEach(() => reset());

const PARTS_URL = "http://localhost/api/users/me/database/parts";

async function etagOf(bytes: Uint8Array<ArrayBuffer>) {
  return `"${await sha256Hex(bytes)}"`;
}

function send(
  method: string,
  url: string,
  token: string | undefined,
  { body, headers = {} }: { body?: BodyInit; headers?: Record<string, string> } = {},
) {
  return exports.default.fetch(url, {
    method,
    headers: {
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      ...headers,
    },
    body,
  });
}

/** `body` is parts, one after the other, or a stream of them. */
function putParts(
  token: string | undefined,
  body: Uint8Array[] | ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
) {
  return send("PUT", PARTS_URL, token, {
    body: Array.isArray(body) ? concatBytes(body) : body,
    headers,
  });
}

function postPart(
  token: string | undefined,
  body: Uint8Array | ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
) {
  return send("POST", PARTS_URL, token, { body, headers });
}

function getParts(token: string | undefined, headers: Record<string, string> = {}) {
  return send("GET", PARTS_URL, token, { headers });
}

function getPart(token: string | undefined, part: number | string) {
  return send("GET", `${PARTS_URL}/${part}`, token);
}

async function newUser(username = "alice") {
  await registerUser(username);
  return loginToken(username);
}

/** The stored database's ETag and content, or the status if there's none to download. */
async function downloaded(token: string) {
  const response = await getParts(token);
  if (response.status !== 200) return response.status;
  return {
    etag: response.headers.get("ETag"),
    body: new Uint8Array(await response.arrayBuffer()),
  };
}

/** What `downloaded` gives for a database of `parts`. */
async function downloadedAs(parts: Uint8Array<ArrayBuffer>[]) {
  return { etag: await etagOf(parts.at(-1)!), body: concatBytes(parts) };
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
async function firstUpload(token: string, parts: Uint8Array[]) {
  const response = await putParts(token, parts, { "If-None-Match": "*" });
  expect(response.status).toBe(204);
  return response.headers.get("ETag")!;
}

/** Server-Timing's metric names. */
function timedMetrics(response: Response) {
  const metrics = response.headers.get("Server-Timing")?.split(",") ?? [];
  return metrics.map((metric) => /^(\w+);dur=[\d.]+(;|$)/.exec(metric)?.[1]);
}

/** A stream with a length, so the runtime sends it as it's written. */
function slowBody(bytes: Uint8Array) {
  const { readable, writable } = new FixedLengthStream(bytes.byteLength);
  return { readable, writer: writable.getWriter() };
}

describe("PUT /api/users/me/database/parts", () => {
  it("requires authentication", async () => {
    const token = await newUser();

    const response = await putParts(undefined, await chainedParts({}), { "If-None-Match": "*" });

    expect(response.status).toBe(401);
    expect(await downloaded(token)).toBe(404);
  });

  it("stores the first database", async () => {
    const token = await newUser();
    const parts = await chainedParts({});

    const etag = await firstUpload(token, parts);

    expect(etag).toBe(await etagOf(parts[0]!));
    expect(await downloaded(token)).toEqual(await downloadedAs(parts));
  });

  it("stores several parts, with the last part's hash as the ETag", async () => {
    const token = await newUser();
    const parts = await chainedParts({}, { size: 300 }, {});

    const etag = await firstUpload(token, parts);

    expect(etag).toBe(await etagOf(parts[2]!));
    expect(await downloaded(token)).toEqual(await downloadedAs(parts));
  });

  it("reports how long receiving and storing the upload took", async () => {
    const token = await newUser();

    const response = await putParts(token, await chainedParts({}), { "If-None-Match": "*" });

    expect(timedMetrics(response)).toEqual(["store", "total"]);
  });

  it("replaces every part when If-Match is current", async () => {
    const token = await newUser();
    const etag = await firstUpload(token, await chainedParts({}, {}, {}));
    const parts = await chainedParts({ seed: 10 });

    const response = await putParts(token, parts, { "If-Match": etag });

    expect(response.status).toBe(204);
    expect(response.headers.get("ETag")).toBe(await etagOf(parts[0]!));
    expect(await downloaded(token)).toEqual(await downloadedAs(parts));
  });

  describe("preconditions", () => {
    it("rejects an upload without a conditional header", async () => {
      const token = await newUser();

      const response = await putParts(token, await chainedParts({}));

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

      const response = await putParts(token, await chainedParts({}), headers);

      expect(response.status).toBe(400);
    });

    it("rejects If-None-Match: * when a database exists", async () => {
      const token = await newUser();
      const parts = await chainedParts({});
      await firstUpload(token, parts);

      const response = await putParts(token, await chainedParts({ seed: 10 }), {
        "If-None-Match": "*",
      });

      expect(response.status).toBe(412);
      expect(await response.json()).toEqual({ error: "PRECONDITION_FAILED" });
      expect(await downloaded(token)).toEqual(await downloadedAs(parts));
    });

    it("rejects a stale If-Match", async () => {
      const token = await newUser();
      const stale = await firstUpload(token, await chainedParts({}));
      const current = await chainedParts({ seed: 10 });
      await putParts(token, current, { "If-Match": stale });

      const response = await putParts(token, await chainedParts({ seed: 20 }), {
        "If-Match": stale,
      });

      expect(response.status).toBe(412);
      expect(await downloaded(token)).toEqual(await downloadedAs(current));
    });

    it("rejects an If-Match naming a part before the last", async () => {
      const token = await newUser();
      const parts = await chainedParts({}, {});
      await firstUpload(token, parts);

      const response = await putParts(token, await chainedParts({ seed: 10 }), {
        "If-Match": await etagOf(parts[0]!),
      });

      expect(response.status).toBe(412);
    });

    it("rejects If-Match before the first upload", async () => {
      const token = await newUser();

      const response = await putParts(token, await chainedParts({}), {
        "If-Match": `"${"0".repeat(64)}"`,
      });

      expect(response.status).toBe(412);
    });
  });

  describe("body", () => {
    it.each([
      ["an empty body", async () => [new Uint8Array()], "MISSING_SPENDY_MAGIC"],
      [
        "the wrong magic",
        async () => [new TextEncoder().encode("SQLITE\x02data")],
        "MISSING_SPENDY_MAGIC",
      ],
      [
        "version 1",
        async () => [databasePart(NO_PREVIOUS_PART).with(6, 0x01)],
        "INVALID_VERSION_BYTE",
      ],
      [
        "a part cut off",
        async () => [databasePart(NO_PREVIOUS_PART).subarray(0, -1)],
        "INVALID_PART_LENGTH",
      ],
      [
        "a part 0 that points at a part",
        async () => [databasePart("a".repeat(64))],
        "BROKEN_PART_CHAIN",
      ],
      [
        "parts out of order",
        async () => (await chainedParts({}, {})).toReversed(),
        "BROKEN_PART_CHAIN",
      ],
      [
        "a user version that goes down",
        () => chainedParts({ userVersion: 2 }, { userVersion: 1 }),
        "USER_VERSION_DECREASED",
      ],
    ])("rejects %s", async (_name, partsOf, error) => {
      const token = await newUser();

      const response = await putParts(token, await partsOf(), { "If-None-Match": "*" });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error });
      expect(await downloaded(token)).toBe(404);
    });

    it("checks the body before the precondition", async () => {
      const token = await newUser();

      // fails the precondition too: there's no database to match
      const response = await putParts(token, [databasePart("a".repeat(64))], {
        "If-Match": `"${"0".repeat(64)}"`,
      });

      expect(response.status).toBe(400);
    });

    it("accepts an upload that doesn't say how long it is", async () => {
      const token = await newUser();
      const parts = await chainedParts({});
      // the runtime knows the length of other streams, like a Response's body
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(parts[0]!);
          controller.close();
        },
      });

      const response = await putParts(token, stream, { "If-None-Match": "*" });

      expect(response.status).toBe(204);
      expect(await downloaded(token)).toEqual(await downloadedAs(parts));
    });

    it("stores parts of several megabytes byte for byte", async () => {
      const token = await newUser();
      const parts = await chainedParts({ size: 3 * 1024 * 1024 + 1 }, { size: 2 * 1024 * 1024 });

      await firstUpload(token, parts);

      expect(await downloadedHashes(token)).toEqual({
        etag: await etagOf(parts[1]!),
        contentEtag: await etagOf(concatBytes(parts)),
      });
    });

    it("replaces a larger database with a smaller one entirely", async () => {
      const token = await newUser();
      const etag = await firstUpload(token, await chainedParts({ size: 3 * 1024 * 1024 }));
      const parts = await chainedParts({ seed: 10 });

      await putParts(token, parts, { "If-Match": etag });

      const replaced = await etagOf(parts[0]!);
      expect(await downloadedHashes(token)).toEqual({ etag: replaced, contentEtag: replaced });
    });
  });

  it("lets only one of two concurrent uploads with the same If-Match win", async () => {
    const token = await newUser();
    const etag = await firstUpload(token, await chainedParts({}));
    const uploads = [await chainedParts({ seed: 10 }), await chainedParts({ seed: 20 })];

    const responses = await Promise.all(
      uploads.map((parts) => putParts(token, parts, { "If-Match": etag })),
    );

    const statuses = responses.map(({ status }) => status);
    expect(statuses.toSorted()).toEqual([204, 412]);
    expect(await downloaded(token)).toEqual(await downloadedAs(uploads[statuses.indexOf(204)]!));
  });

  it("checks If-Match once an upload has arrived, against any stored meanwhile", async () => {
    const token = await newUser();
    const etag = await firstUpload(token, await chainedParts({}));
    const [slow] = await chainedParts({ seed: 10 });
    const { readable, writer } = slowBody(slow!);

    const slowUpload = putParts(token, readable, { "If-Match": etag });
    await writer.write(slow!.subarray(0, 4));
    // give the slow upload every chance to reach the user store
    await new Promise((resolve) => setTimeout(resolve, 100));
    const fast = await chainedParts({ seed: 20 });
    const fastUpload = await putParts(token, fast, { "If-Match": etag });
    await writer.write(slow!.subarray(4));
    await writer.close();

    expect(fastUpload.status).toBe(204);
    expect((await slowUpload).status).toBe(412);
    expect(await downloaded(token)).toEqual(await downloadedAs(fast));
  });
});

describe("POST /api/users/me/database/parts", () => {
  /** A user with a database of one part, which is returned. */
  async function userWithDatabase() {
    const token = await newUser();
    const [first] = await chainedParts({});
    await firstUpload(token, [first!]);
    return { token, first: first! };
  }

  it("requires authentication", async () => {
    const { token, first } = await userWithDatabase();

    const response = await postPart(undefined, databasePart(await sha256Hex(first)), {
      "If-Match": await etagOf(first),
    });

    expect(response.status).toBe(401);
    expect(await downloaded(token)).toEqual(await downloadedAs([first]));
  });

  it("adds a part after the last one, whose hash is then the ETag", async () => {
    const { token, first } = await userWithDatabase();
    const second = databasePart(await sha256Hex(first));

    const response = await postPart(token, second, { "If-Match": await etagOf(first) });

    expect(response.status).toBe(204);
    expect(response.headers.get("ETag")).toBe(await etagOf(second));
    expect(await downloaded(token)).toEqual(await downloadedAs([first, second]));
  });

  it("adds parts one after the other, each after the ETag of the last", async () => {
    const { token, first } = await userWithDatabase();
    const second = databasePart(await sha256Hex(first));
    const third = databasePart(await sha256Hex(second));

    const etag = (await postPart(token, second, { "If-Match": await etagOf(first) })).headers.get(
      "ETag",
    )!;
    const response = await postPart(token, third, { "If-Match": etag });

    expect(response.status).toBe(204);
    expect(await downloaded(token)).toEqual(await downloadedAs([first, second, third]));
  });

  it("reports how long receiving and storing the part took", async () => {
    const { token, first } = await userWithDatabase();

    const response = await postPart(token, databasePart(await sha256Hex(first)), {
      "If-Match": await etagOf(first),
    });

    expect(timedMetrics(response)).toEqual(["store", "total"]);
  });

  describe("preconditions", () => {
    it("requires If-Match", async () => {
      const { token, first } = await userWithDatabase();

      const response = await postPart(token, databasePart(await sha256Hex(first)));

      expect(response.status).toBe(400);
      expect(await downloaded(token)).toEqual(await downloadedAs([first]));
    });

    it("rejects a stale If-Match", async () => {
      const { token, first } = await userWithDatabase();
      const second = databasePart(await sha256Hex(first));
      await postPart(token, second, { "If-Match": await etagOf(first) });

      const response = await postPart(token, databasePart(await sha256Hex(first), { seed: 9 }), {
        "If-Match": await etagOf(first),
      });

      expect(response.status).toBe(412);
      expect(await response.json()).toEqual({ error: "PRECONDITION_FAILED" });
      expect(await downloaded(token)).toEqual(await downloadedAs([first, second]));
    });

    it("can't create a database, not even with part 0", async () => {
      const token = await newUser();

      const response = await postPart(token, databasePart(NO_PREVIOUS_PART), {
        "If-Match": `"${NO_PREVIOUS_PART}"`,
      });

      expect(response.status).toBe(412);
      expect(await downloaded(token)).toBe(404);
    });
  });

  describe("body", () => {
    it("rejects a part that doesn't point at the last part, as If-Match does", async () => {
      const { token, first } = await userWithDatabase();

      const response = await postPart(token, databasePart("a".repeat(64)), {
        "If-Match": await etagOf(first),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "BROKEN_PART_CHAIN" });
      expect(await downloaded(token)).toEqual(await downloadedAs([first]));
    });

    it("rejects a part whose user version is lower than the last part's", async () => {
      const token = await newUser();
      const [first] = await chainedParts({ userVersion: 2 });
      await firstUpload(token, [first!]);

      const response = await postPart(
        token,
        databasePart(await sha256Hex(first!), { userVersion: 1 }),
        {
          "If-Match": await etagOf(first!),
        },
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "USER_VERSION_DECREASED" });
    });

    it("rejects two parts at once", async () => {
      const { token, first } = await userWithDatabase();
      const second = databasePart(await sha256Hex(first));
      const third = databasePart(await sha256Hex(second));

      const response = await postPart(token, concatBytes([second, third]), {
        "If-Match": await etagOf(first),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "INVALID_PART_LENGTH" });
      expect(await downloaded(token)).toEqual(await downloadedAs([first]));
    });

    it.each([
      ["an empty body", new Uint8Array(), "MISSING_SPENDY_MAGIC"],
      ["version 1", databasePart(NO_PREVIOUS_PART).with(6, 0x01), "INVALID_VERSION_BYTE"],
      ["a part cut off", databasePart(NO_PREVIOUS_PART).subarray(0, -1), "INVALID_PART_LENGTH"],
    ])("rejects %s", async (_name, body, error) => {
      const { token, first } = await userWithDatabase();

      const response = await postPart(token, body, { "If-Match": await etagOf(first) });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error });
    });
  });

  it("lets only one of two concurrent additions with the same If-Match win", async () => {
    const { token, first } = await userWithDatabase();
    const etag = await etagOf(first);
    const additions = [
      databasePart(await sha256Hex(first), { seed: 10 }),
      databasePart(await sha256Hex(first), { seed: 20 }),
    ];

    const responses = await Promise.all(
      additions.map((part) => postPart(token, part, { "If-Match": etag })),
    );

    const statuses = responses.map(({ status }) => status);
    expect(statuses.toSorted()).toEqual([204, 412]);
    expect(await downloaded(token)).toEqual(
      await downloadedAs([first, additions[statuses.indexOf(204)]!]),
    );
  });

  it("checks If-Match once a part has arrived, against any added meanwhile", async () => {
    const { token, first } = await userWithDatabase();
    const etag = await etagOf(first);
    const slow = databasePart(await sha256Hex(first), { seed: 10 });
    const { readable, writer } = slowBody(slow);

    const slowAddition = postPart(token, readable, { "If-Match": etag });
    await writer.write(slow.subarray(0, 4));
    // give the slow addition every chance to reach the user store
    await new Promise((resolve) => setTimeout(resolve, 100));
    const fast = databasePart(await sha256Hex(first), { seed: 20 });
    const fastAddition = await postPart(token, fast, { "If-Match": etag });
    await writer.write(slow.subarray(4));
    await writer.close();

    expect(fastAddition.status).toBe(204);
    expect((await slowAddition).status).toBe(412);
    expect(await downloaded(token)).toEqual(await downloadedAs([first, fast]));
  });
});

describe("GET /api/users/me/database/parts", () => {
  it("requires authentication", async () => {
    const response = await getParts(undefined);
    expect(response.status).toBe(401);
  });

  it("returns 404 before the first upload", async () => {
    const token = await newUser();

    const response = await getParts(token);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "NOT_FOUND" });
  });

  it("returns every part, one after the other, and the last part's ETag", async () => {
    const token = await newUser();
    const parts = await chainedParts({}, { size: 300 });
    const etag = await firstUpload(token, parts);

    const response = await getParts(token);

    expect(response.status).toBe(200);
    expect(response.headers.get("ETag")).toBe(etag);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(concatBytes(parts));
  });

  it("only returns the user's own database", async () => {
    const alice = await newUser("alice");
    await firstUpload(alice, await chainedParts({}));
    const bob = await newUser("bob");

    expect((await getParts(bob)).status).toBe(404);
  });

  // An RPC message, such as one from the user store, holds at most 32 MiB.
  it("returns a database larger than an RPC message", async () => {
    const token = await newUser();
    const parts = await chainedParts({ size: 17 * 1024 * 1024 }, { size: 17 * 1024 * 1024 });
    await firstUpload(token, parts);

    expect(await downloadedHashes(token)).toEqual({
      etag: await etagOf(parts[1]!),
      contentEtag: await etagOf(concatBytes(parts)),
    });
  });

  it("fails partway through the body when the database is replaced meanwhile", async () => {
    const token = await newUser();
    // far more than the response holds before it's read
    const parts = await chainedParts({ size: 32 * 1024 * 1024 });
    const etag = await firstUpload(token, parts);

    const response = await getParts(token);
    const reader = response.body!.getReader();
    await reader.read();
    expect(
      (await putParts(token, await chainedParts({ seed: 9 }), { "If-Match": etag })).status,
    ).toBe(204);

    await expect(
      (async () => {
        while (!(await reader.read()).done);
      })(),
    ).rejects.toThrow();
  });

  describe("If-None-Match", () => {
    it("returns 304 for the current version", async () => {
      const token = await newUser();
      const etag = await firstUpload(token, await chainedParts({}));

      const response = await getParts(token, { "If-None-Match": etag });

      expect(response.status).toBe(304);
      expect(response.headers.get("ETag")).toBe(etag);
      expect(await response.arrayBuffer()).toHaveProperty("byteLength", 0);
    });

    it("returns the database when a part has been added since", async () => {
      const token = await newUser();
      const [first] = await chainedParts({});
      const old = await firstUpload(token, [first!]);
      const second = databasePart(await sha256Hex(first!));
      await postPart(token, second, { "If-Match": old });

      const response = await getParts(token, { "If-None-Match": old });

      expect(response.status).toBe(200);
      expect(response.headers.get("ETag")).toBe(await etagOf(second));
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(concatBytes([first!, second]));
    });

    it("returns 404 when there's no database", async () => {
      const token = await newUser();

      const response = await getParts(token, { "If-None-Match": `"${"a".repeat(64)}"` });

      expect(response.status).toBe(404);
    });

    it("requires authentication", async () => {
      const token = await newUser();
      const etag = await firstUpload(token, await chainedParts({}));

      expect((await getParts(undefined, { "If-None-Match": etag })).status).toBe(401);
    });

    it.each(["*", 'W/"abc"', `"${"a".repeat(64)}", "${"b".repeat(64)}"`])(
      "rejects an If-None-Match it doesn't support: %s",
      async (header) => {
        const token = await newUser();
        await firstUpload(token, await chainedParts({}));

        expect((await getParts(token, { "If-None-Match": header })).status).toBe(400);
      },
    );
  });
});

describe("GET /api/users/me/database/parts/{part}", () => {
  it("requires authentication", async () => {
    const token = await newUser();
    await firstUpload(token, await chainedParts({}));

    expect((await getPart(undefined, 0)).status).toBe(401);
  });

  it("returns each part with its own ETag", async () => {
    const token = await newUser();
    const parts = await chainedParts({}, { size: 300 });
    await firstUpload(token, parts);

    for (const [i, part] of parts.entries()) {
      const response = await getPart(token, i);

      expect(response.status).toBe(200);
      expect(response.headers.get("ETag")).toBe(await etagOf(part));
      expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(part);
    }
  });

  it("returns a part larger than an RPC message", async () => {
    const token = await newUser();
    const parts = await chainedParts({}, { size: 33 * 1024 * 1024 });
    await firstUpload(token, parts);

    const response = await getPart(token, 1);

    expect(response.status).toBe(200);
    // a hash rather than toEqual: a failing toEqual would print megabytes
    expect(await etagOf(new Uint8Array(await response.arrayBuffer()))).toBe(
      await etagOf(parts[1]!),
    );
  });

  it("returns 404 for a part past the last", async () => {
    const token = await newUser();
    await firstUpload(token, await chainedParts({}, {}));

    const response = await getPart(token, 2);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "NOT_FOUND" });
  });

  it("returns 404 before the first upload", async () => {
    const token = await newUser();

    expect((await getPart(token, 0)).status).toBe(404);
  });

  it.each(["-1", "01", "1.0", "1e1", "0x1", "a", String(2 ** 53)])(
    "rejects a part that isn't written as a whole number: %s",
    async (part) => {
      const token = await newUser();
      await firstUpload(token, await chainedParts({}, {}));

      expect((await getPart(token, part)).status).toBe(400);
    },
  );
});
