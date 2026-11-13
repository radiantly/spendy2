import { afterEach, describe, expect, it, vi } from "vitest";
import { deployAssets, type AssetFile } from "./assets.ts";
import { contentHash, utf8, type AssetEntry } from "./format.ts";
import { FakeCloud } from "./test/fakeCloud.ts";

const ACCOUNT = { accountId: "account", apiToken: "token" };
const SESSION =
  "POST https://api.cloudflare.com/client/v4/accounts/account/workers/scripts/currency/assets-upload-session";
const UPLOAD =
  "POST https://api.cloudflare.com/client/v4/accounts/account/workers/assets/upload?base64=true";
const DEPLOY = "PUT https://api.cloudflare.com/client/v4/accounts/account/workers/scripts/currency";

/** Bytes that are different for every `seed`, and take every value. */
function bytesOf(length: number, seed = length) {
  const bytes = new Uint8Array(length);
  let state = seed + 1;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

/** A deploy's manifest and files for assets of these bytes, by path. */
async function assetsOf(contents: Record<string, Uint8Array<ArrayBuffer>>) {
  const manifest: Record<string, AssetEntry> = {};
  const files = new Map<string, AssetFile>();
  for (const [path, bytes] of Object.entries(contents)) {
    manifest[path] = { hash: await contentHash(bytes), size: bytes.length };
    files.set(path, { bytes, contentType: "application/octet-stream" });
  }
  return { manifest, files };
}

/** A cloud that `fetch` goes to. */
function fakeCloud() {
  const cloud = new FakeCloud();
  vi.stubGlobal("fetch", cloud.fetch);
  return cloud;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("deployAssets", () => {
  it("uploads the files and has them served", async () => {
    const cloud = fakeCloud();
    const contents = { "/USD-5": bytesOf(80), "/GBP-5": bytesOf(72), "/5": bytesOf(152) };
    const { manifest, files } = await assetsOf(contents);

    const stats = await deployAssets(ACCOUNT, "currency", manifest, files);

    expect(cloud.requests).toEqual([SESSION, UPLOAD, DEPLOY]);
    expect(cloud.served).toEqual(new Map(Object.entries(contents)));
    expect(stats).toEqual({ requests: 3, buckets: 1, uploadedFiles: 3, uploadedBytes: 304 });
  });

  it.for([1, 2, 3, 4, 71_999, 72_000, 72_001, 144_001, 4096 * 8, 1_000_000])(
    "uploads a file of %i bytes as it is",
    async (size) => {
      const cloud = fakeCloud();
      const bytes = bytesOf(size);
      const { manifest, files } = await assetsOf({ "/USD-5": bytes, "/other": bytesOf(10) });

      await deployAssets(ACCOUNT, "currency", manifest, files);

      expect(cloud.served.get("/USD-5")!.length).toBe(size);
      // Not `toEqual`: its diff of a megabyte that differs takes minutes.
      expect(await contentHash(cloud.served.get("/USD-5")!)).toBe(manifest["/USD-5"]!.hash);
      expect(cloud.served.get("/other")).toEqual(bytesOf(10));
    },
  );

  it("uploads each file under its hash, with its Content-Type", async () => {
    const cloud = fakeCloud();
    const { manifest, files } = await assetsOf({ "/USD-5": bytesOf(80) });
    const json = utf8('{"currencies":["USD"]}');
    manifest["/manifest.json"] = { hash: await contentHash(json), size: json.length };
    files.set("/manifest.json", { bytes: json, contentType: "application/json" });

    await deployAssets(ACCOUNT, "currency", manifest, files);

    expect(cloud.contentTypes).toEqual(
      new Map([
        [manifest["/USD-5"]!.hash, "application/octet-stream"],
        [manifest["/manifest.json"]!.hash, "application/json"],
      ]),
    );
  });

  it("uploads only what Cloudflare doesn't have", async () => {
    const cloud = fakeCloud();
    const first = await assetsOf({ "/USD-5": bytesOf(80), "/GBP-5": bytesOf(72) });
    await deployAssets(ACCOUNT, "currency", first.manifest, first.files);
    cloud.uploaded = [];

    const second = await assetsOf({ "/USD-5": bytesOf(88), "/GBP-5": bytesOf(72) });
    const stats = await deployAssets(ACCOUNT, "currency", second.manifest, second.files);

    expect(cloud.uploaded).toEqual([second.manifest["/USD-5"]!.hash]);
    expect(stats).toEqual({ requests: 3, buckets: 1, uploadedFiles: 1, uploadedBytes: 88 });
    expect(cloud.served.get("/USD-5")).toEqual(bytesOf(88));
    expect(cloud.served.get("/GBP-5")).toEqual(bytesOf(72));
  });

  it("keeps an asset that isn't among the files, when Cloudflare has it", async () => {
    const cloud = fakeCloud();
    const first = await assetsOf({ "/USD-4": bytesOf(64), "/USD-5": bytesOf(80) });
    await deployAssets(ACCOUNT, "currency", first.manifest, first.files);

    const second = await assetsOf({ "/USD-5": bytesOf(88) });
    const manifest = { ...first.manifest, ...second.manifest };
    await deployAssets(ACCOUNT, "currency", manifest, second.files);

    expect(cloud.served.get("/USD-4")).toEqual(bytesOf(64));
    expect(cloud.served.get("/USD-5")).toEqual(bytesOf(88));
  });

  it("stops serving an asset the manifest leaves out", async () => {
    const cloud = fakeCloud();
    const first = await assetsOf({ "/5": bytesOf(80), "/USD-5": bytesOf(80, 1) });
    await deployAssets(ACCOUNT, "currency", first.manifest, first.files);

    const { "/5": _, ...manifest } = first.manifest;
    await deployAssets(ACCOUNT, "currency", manifest, new Map());

    expect([...cloud.served.keys()]).toEqual(["/USD-5"]);
  });

  it("deploys without an upload when Cloudflare has every file", async () => {
    const cloud = fakeCloud();
    const { manifest, files } = await assetsOf({ "/USD-5": bytesOf(80) });
    await deployAssets(ACCOUNT, "currency", manifest, files);
    cloud.requests = [];

    const stats = await deployAssets(ACCOUNT, "currency", manifest, files);

    expect(cloud.requests).toEqual([SESSION, DEPLOY]);
    expect(stats).toEqual({ requests: 2, buckets: 0, uploadedFiles: 0, uploadedBytes: 0 });
    expect(cloud.deploys).toBe(2);
  });

  it("uploads a file two paths have once", async () => {
    const cloud = fakeCloud();
    const { manifest, files } = await assetsOf({ "/USD-5": bytesOf(80), "/5": bytesOf(80) });

    const stats = await deployAssets(ACCOUNT, "currency", manifest, files);

    expect(cloud.uploaded).toEqual([manifest["/5"]!.hash]);
    expect(stats.uploadedFiles).toBe(1);
    expect(cloud.served.get("/USD-5")).toEqual(bytesOf(80));
    expect(cloud.served.get("/5")).toEqual(bytesOf(80));
  });

  it("uploads the buckets at the same time", async () => {
    const cloud = fakeCloud();
    cloud.bucketSize = 2;
    const contents = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [`/C${index}-5`, bytesOf(80, index)]),
    );
    const { manifest, files } = await assetsOf(contents);

    const stats = await deployAssets(ACCOUNT, "currency", manifest, files);

    expect(cloud.requests).toEqual([SESSION, UPLOAD, UPLOAD, UPLOAD, DEPLOY]);
    expect(cloud.uploadsAtOnce).toBe(3);
    expect(stats).toEqual({ requests: 5, buckets: 3, uploadedFiles: 5, uploadedBytes: 400 });
    expect(cloud.served).toEqual(new Map(Object.entries(contents)));
  });

  it("deploys with the token of whichever upload was the last to be taken in", async () => {
    const cloud = fakeCloud();
    cloud.bucketSize = 1;
    cloud.firstUploadLast = true;
    const { manifest, files } = await assetsOf({
      "/USD-5": bytesOf(80, 1),
      "/GBP-5": bytesOf(80, 2),
      "/JPY-5": bytesOf(80, 3),
    });

    await deployAssets(ACCOUNT, "currency", manifest, files);

    // The first bucket's, though it was sent first.
    expect(cloud.uploaded.at(-1)).toBe(manifest["/USD-5"]!.hash);
    expect(cloud.deploys).toBe(1);
  });

  it("starts and deploys with the account's token, and uploads with the session's", async () => {
    const cloud = fakeCloud();
    const { manifest, files } = await assetsOf({ "/USD-5": bytesOf(80) });

    await deployAssets(ACCOUNT, "currency", manifest, files);

    expect(cloud.authorizations).toEqual([
      "Bearer token",
      expect.stringMatching(/^Bearer header\..+\.signature$/),
      "Bearer token",
    ]);
  });

  it("deploys a worker of nothing but its assets, that any page may read", async () => {
    const cloud = fakeCloud();
    const { manifest, files } = await assetsOf({ "/USD-5": bytesOf(80) });

    await deployAssets(ACCOUNT, "currency", manifest, files);

    expect(cloud.lastDeploy).toEqual({
      parts: ["metadata"],
      metadata: {
        assets: {
          jwt: expect.any(String),
          config: { _headers: "/*\n  Access-Control-Allow-Origin: *\n" },
        },
        compatibility_date: "2026-11-10",
      },
    });
  });

  it("throws before uploading anything when asked for a file it wasn't given", async () => {
    const cloud = fakeCloud();
    cloud.bucketSize = 1;
    const { manifest, files } = await assetsOf({ "/USD-5": bytesOf(80), "/GBP-5": bytesOf(72) });
    files.delete("/GBP-5");

    await expect(deployAssets(ACCOUNT, "currency", manifest, files)).rejects.toThrow(
      `Asked to upload ${manifest["/GBP-5"]!.hash}, which isn't a changed file`,
    );
    expect(cloud.requests).toEqual([SESSION]);
  });

  it("throws when Cloudflare asks for a request for each file", async () => {
    const cloud = fakeCloud();
    cloud.sessionClaims = { wrangler_single_asset_uploads: true };
    const { manifest, files } = await assetsOf({ "/USD-5": bytesOf(80) });

    await expect(deployAssets(ACCOUNT, "currency", manifest, files)).rejects.toThrow(
      "Cloudflare asked for one upload request per file",
    );
    expect(cloud.requests).toEqual([SESSION]);
  });

  it("throws when no upload is answered with the token to deploy with", async () => {
    const cloud = fakeCloud();
    cloud.withholdCompletion = true;
    const { manifest, files } = await assetsOf({ "/USD-5": bytesOf(80) });

    await expect(deployAssets(ACCOUNT, "currency", manifest, files)).rejects.toThrow(
      "Cloudflare didn't say that it has every file",
    );
    expect(cloud.requests).toEqual([SESSION, UPLOAD]);
  });

  it.for([
    ["session", "Starting the upload: 500", [SESSION]],
    ["upload", "Uploading a bucket: 503", [SESSION, UPLOAD]],
    ["deploy", "Deploying: 500", [SESSION, UPLOAD, DEPLOY]],
  ] as const)("throws with what the API said when the %s fails", async ([step, message, made]) => {
    const cloud = fakeCloud();
    const before = await assetsOf({ "/USD-5": bytesOf(80) });
    await deployAssets(ACCOUNT, "currency", before.manifest, before.files);
    cloud.requests = [];
    cloud.failing = { [step]: Number(message.slice(-3)) };
    const { manifest, files } = await assetsOf({ "/USD-5": bytesOf(88) });

    await expect(deployAssets(ACCOUNT, "currency", manifest, files)).rejects.toThrow(message);
    await expect(deployAssets(ACCOUNT, "currency", manifest, files)).rejects.toThrow(/"No \w+"/);
    expect(cloud.requests.slice(0, made.length)).toEqual(made);
    // What is served is as it was.
    expect(cloud.served.get("/USD-5")).toEqual(bytesOf(80));
    expect(cloud.deploys).toBe(1);
  });

  it("can be made again after it failed at the last step", async () => {
    const cloud = fakeCloud();
    const { manifest, files } = await assetsOf({ "/USD-5": bytesOf(80), "/5": bytesOf(80, 1) });
    cloud.failing = { deploy: 500 };
    await expect(deployAssets(ACCOUNT, "currency", manifest, files)).rejects.toThrow("Deploying");
    cloud.failing = {};
    cloud.requests = [];

    const stats = await deployAssets(ACCOUNT, "currency", manifest, files);

    // The files are there from the first time.
    expect(cloud.requests).toEqual([SESSION, DEPLOY]);
    expect(stats.uploadedFiles).toBe(0);
    expect(cloud.served.get("/USD-5")).toEqual(bytesOf(80));
  });

  it("throws for an answer that isn't the API's, with its start", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>Bad gateway</html>", { status: 502 }));
    await expect(deployAssets(ACCOUNT, "currency", {}, new Map())).rejects.toThrow(
      "Starting the upload: 502 <html>Bad gateway</html>",
    );
  });

  it("throws for a 200 that says it failed", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ success: false, errors: [{ code: 10007, message: "No such script" }] }),
    );
    await expect(deployAssets(ACCOUNT, "currency", {}, new Map())).rejects.toThrow(
      /Starting the upload: 200 .*No such script/,
    );
  });
});
