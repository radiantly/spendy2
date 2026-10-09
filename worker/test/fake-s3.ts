import { env } from "cloudflare:workers";
import { vi } from "vitest";
import { toSha256Schema } from "../schemas.ts";

export type FakeObject = {
  body: Uint8Array;
  /** x-amz-meta-* headers, lowercase */
  metadata: Record<string, string>;
};

/**
 * Replaces fetch with an in-memory S3 that serves the test bucket. Any other
 * request throws, so tests never reach a real host. Restored by
 * vi.restoreAllMocks().
 */
export function installFakeS3() {
  /** object key (without bucket) -> object */
  const objects = new Map<string, FakeObject>();
  let failStatus: number | undefined;
  // plain values rather than promises: a promise created in a durable object
  // cannot be resolved from the test context
  let holdingPuts = false;
  let heldPutCount = 0;
  let putCount = 0;

  const bucketUrl = `${env.S3_ENDPOINT}/${env.S3_BUCKET}/`;

  async function handle(request: Request): Promise<Response> {
    if (!request.url.startsWith(bucketUrl)) throw new Error(`Unexpected fetch to ${request.url}`);
    if (!request.headers.get("Authorization")?.startsWith("AWS4-HMAC-SHA256"))
      return new Response("Missing signature", { status: 403 });
    if (failStatus !== undefined) return new Response("Injected failure", { status: failStatus });

    const key = decodeURIComponent(request.url.slice(bucketUrl.length));

    if (request.method === "PUT") {
      putCount++;
      const body = await request.arrayBuffer();
      if (request.headers.get("X-Amz-Content-Sha256") !== (await toSha256Schema.decodeAsync(body)))
        return new Response("BadDigest", { status: 400 });

      if (holdingPuts) {
        heldPutCount++;
        while (holdingPuts) await new Promise((resolve) => setTimeout(resolve, 5));
        heldPutCount--;
      }

      const metadata: Record<string, string> = {};
      for (const [name, value] of request.headers)
        if (name.startsWith("x-amz-meta-")) metadata[name] = value;
      objects.set(key, { body: new Uint8Array(body), metadata });
      return new Response(null, { status: 200 });
    }

    if (request.method === "GET") {
      const object = objects.get(key);
      if (object === undefined) return new Response("NoSuchKey", { status: 404 });
      return new Response(object.body, { headers: object.metadata });
    }

    throw new Error(`Unexpected ${request.method} to ${request.url}`);
  }

  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    handle(new Request(input, init)),
  );

  return {
    objects,
    /** Number of PUT requests that reached the bucket. */
    get putCount() {
      return putCount;
    },
    /** Every following request fails with the given status. */
    failRequests(status: number) {
      failStatus = status;
    },
    /** Undoes failRequests(). */
    recover() {
      failStatus = undefined;
    },
    /** Following PUTs wait before they are stored, until release(). */
    holdPuts() {
      holdingPuts = true;
    },
    /** Number of PUTs currently waiting for release(). */
    get heldPutCount() {
      return heldPutCount;
    },
    release() {
      holdingPuts = false;
    },
  };
}
