export type DownloadResult =
  | { success: true; blob: Uint8Array<ArrayBuffer>; sha256: string }
  | { success: false; code: DownloadErrorCode };

/** NOT_FOUND means the user has never saved a database. */
export type DownloadErrorCode = "NOT_FOUND" | "UNAUTHORIZED" | "DOWNLOAD_FAILED";

export type UploadResult =
  | { success: true; sha256: string }
  | { success: false; code: UploadErrorCode };

/**
 * CONFLICT means the stored database isn't the one this upload was based on,
 * for example because another device saved in between.
 */
export type UploadErrorCode = "CONFLICT" | "UNAUTHORIZED" | "TOO_LARGE" | "UPLOAD_FAILED";

/**
 * The version an upload replaces: the sha256 of the stored blob, or
 * `ifNoneMatch` for the first upload.
 */
export type UploadPrecondition = { ifMatch: string } | { ifNoneMatch: true };

const DATABASE_URL = "/api/users/me/database";

/** Network failures throw. */
export async function downloadDatabase(token: string): Promise<DownloadResult> {
  return readDownload(await fetchDatabase(token));
}

/**
 * Downloads the database only if it isn't the version `sha256` names;
 * NOT_MODIFIED if it still is. Network failures throw.
 */
export async function downloadDatabaseIfChanged(
  token: string,
  sha256: string,
): Promise<DownloadResult | { success: false; code: "NOT_MODIFIED" }> {
  const res = await fetchDatabase(token, { "If-None-Match": `"${sha256}"` });
  if (res.status === 304) return { success: false, code: "NOT_MODIFIED" };
  return readDownload(res);
}

function fetchDatabase(token: string, headers: Record<string, string> = {}) {
  return fetch(DATABASE_URL, { headers: { Authorization: `Bearer ${token}`, ...headers } });
}

async function readDownload(res: Response): Promise<DownloadResult> {
  if (res.status === 404) return { success: false, code: "NOT_FOUND" };
  if (res.status === 401) return { success: false, code: "UNAUTHORIZED" };
  const sha256 = parseEtag(res.headers.get("ETag"));
  if (!res.ok || sha256 === undefined) return { success: false, code: "DOWNLOAD_FAILED" };

  return { success: true, blob: new Uint8Array(await res.arrayBuffer()), sha256 };
}

/** Network failures throw. */
export async function uploadDatabase(
  token: string,
  blob: Uint8Array<ArrayBuffer>,
  precondition: UploadPrecondition,
): Promise<UploadResult> {
  const res = await fetch(DATABASE_URL, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      ...("ifMatch" in precondition
        ? { "If-Match": `"${precondition.ifMatch}"` }
        : { "If-None-Match": "*" }),
    },
    body: blob,
  });
  if (res.status === 412) return { success: false, code: "CONFLICT" };
  if (res.status === 401) return { success: false, code: "UNAUTHORIZED" };
  if (res.status === 413) return { success: false, code: "TOO_LARGE" };
  const sha256 = parseEtag(res.headers.get("ETag"));
  if (!res.ok || sha256 === undefined) return { success: false, code: "UPLOAD_FAILED" };

  return { success: true, sha256 };
}

/** The server sends the blob's sha256 as a strong ETag. */
function parseEtag(etag: string | null) {
  return /^"([0-9a-f]{64})"$/.exec(etag ?? "")?.[1];
}
