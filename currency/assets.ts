/**
 * Replaces a worker's static assets through Cloudflare's API, the way
 * `wrangler deploy` does, for a worker that is nothing but its assets. It
 * runs both in a worker and in Node: everything it uses is in both.
 *
 * A deploy names every asset the worker is to have, by path, with a hash and
 * a size. Cloudflare answers with the hashes it doesn't have yet, in the
 * buckets to upload them in; the rest it keeps from earlier deploys. Until
 * the last step nothing that is served changes, so a deploy that fails
 * part-way leaves the worker as it was, and can be made again.
 */
import type { AssetEntry } from "./format.ts";

const API = "https://api.cloudflare.com/client/v4";

/** The date of the worker's runtime behaviour. It runs no code, so nothing rides on it. */
const COMPATIBILITY_DATE = "2026-11-10";

/**
 * The assets' `_headers`, as the file would have it. Any page may read the
 * rates: they're public, and the app is on another origin.
 */
const HEADERS = `/*
  Access-Control-Allow-Origin: *
`;

/** The account to deploy to, and a token that may edit the worker's script. */
export type Account = { accountId: string; apiToken: string };

/** An asset's bytes, and the Content-Type to serve them with. */
export type AssetFile = { bytes: Uint8Array<ArrayBuffer>; contentType: string };

/** What a deploy took, for judging it against a worker's limits. */
export type DeployStats = {
  /** The requests made to Cloudflare's API. */
  requests: number;
  /** The upload requests among them: one for each bucket. */
  buckets: number;
  uploadedFiles: number;
  uploadedBytes: number;
};

type ApiResponse<Result> = {
  success: boolean;
  errors: { code: number; message: string }[] | null;
  result: Result | null;
};

/** A request to the API's result. Throws, with what the API said, when it failed. */
async function api<Result>(step: string, path: string, init: RequestInit): Promise<Result | null> {
  const response = await fetch(`${API}${path}`, init);
  const text = await response.text();
  let body: ApiResponse<Result> | undefined;
  try {
    body = JSON.parse(text) as ApiResponse<Result>;
  } catch {
    // Not the API's JSON: a gateway's error page, say.
  }
  if (!response.ok || body?.success !== true)
    throw new Error(`${step}: ${response.status} ${text.slice(0, 500)}`);
  return body.result;
}

/** A JWT's claims. */
function claims(jwt: string): Record<string, unknown> {
  const payload = Uint8Array.fromBase64(jwt.split(".")[1] ?? "", { alphabet: "base64url" });
  return JSON.parse(new TextDecoder().decode(payload));
}

/**
 * Makes `manifest` the assets of the worker `scriptName`, and the worker
 * nothing else. `files` are the assets it may be asked to upload, by path:
 * at least those new or changed since the last deploy. Throws if Cloudflare
 * asks for one that isn't among them.
 */
export async function deployAssets(
  account: Account,
  scriptName: string,
  manifest: Record<string, AssetEntry>,
  files: Map<string, AssetFile>,
): Promise<DeployStats> {
  const script = `/accounts/${account.accountId}/workers/scripts/${scriptName}`;
  const authorization = { Authorization: `Bearer ${account.apiToken}` };

  const session = await api<{ jwt: string; buckets: string[][] }>(
    "Starting the upload",
    `${script}/assets-upload-session`,
    {
      method: "POST",
      headers: { ...authorization, "Content-Type": "application/json" },
      body: JSON.stringify({ manifest }),
    },
  );
  if (session === null) throw new Error("Starting the upload: no result");
  // Wrangler then uploads each file in a request of its own, unencoded. That
  // is far more requests than a free worker may make, so it's not done here.
  if (claims(session.jwt).wrangler_single_asset_uploads === true)
    throw new Error("Cloudflare asked for one upload request per file");

  const byHash = new Map<string, AssetFile>();
  for (const [path, file] of files) {
    const entry = manifest[path];
    if (entry !== undefined) byHash.set(entry.hash, file);
  }

  let uploadedFiles = 0;
  let uploadedBytes = 0;
  // Every form is made before any is sent: a file that's missing is found
  // out before anything is uploaded.
  const forms = session.buckets.map((bucket) => {
    const form = new FormData();
    for (const hash of bucket) {
      const file = byHash.get(hash);
      if (file === undefined)
        throw new Error(`Asked to upload ${hash}, which isn't a changed file`);
      form.append(hash, new File([file.bytes.toBase64()], hash, { type: file.contentType }), hash);
      uploadedFiles += 1;
      uploadedBytes += file.bytes.length;
    }
    return form;
  });

  // All at once. A worker has six connections out at a time, and waits with
  // the rest by itself.
  const uploads = await Promise.all(
    forms.map((form) =>
      api<{ jwt?: string }>(
        "Uploading a bucket",
        `/accounts/${account.accountId}/workers/assets/upload?base64=true`,
        { method: "POST", headers: { Authorization: `Bearer ${session.jwt}` }, body: form },
      ),
    ),
  );
  // The token to deploy with comes with the answer to whichever upload had
  // the last file. Without anything to upload, the session's is already it.
  const completion =
    forms.length === 0 ? session.jwt : uploads.find((upload) => upload?.jwt !== undefined)?.jwt;
  if (completion === undefined)
    throw new Error("Uploading: Cloudflare didn't say that it has every file");

  const deploy = new FormData();
  deploy.set(
    "metadata",
    JSON.stringify({
      assets: { jwt: completion, config: { _headers: HEADERS } },
      compatibility_date: COMPATIBILITY_DATE,
    }),
  );
  await api("Deploying", script, { method: "PUT", headers: authorization, body: deploy });

  return {
    requests: session.buckets.length + 2,
    buckets: session.buckets.length,
    uploadedFiles,
    uploadedBytes,
  };
}
