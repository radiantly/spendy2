export type DownloadResult =
  | { success: true; parts: Uint8Array<ArrayBuffer>; sha256: string }
  | { success: false; code: DownloadErrorCode };

/** NOT_FOUND means the user has never saved a database, or a part asked for isn't there. */
export type DownloadErrorCode = "NOT_FOUND" | "UNAUTHORIZED" | "DOWNLOAD_FAILED";

/** `sha256` is the stored database's last part's, its ETag. */
export type UploadResult =
  | { success: true; sha256: string }
  | { success: false; code: UploadErrorCode };

/**
 * CONFLICT means the stored database isn't the one this upload was based on,
 * for example because another device saved in between.
 */
export type UploadErrorCode = "CONFLICT" | "UNAUTHORIZED" | "UPLOAD_FAILED";

/**
 * The version an upload replaces: the sha256 of the stored database's last
 * part, or `ifNoneMatch` for the first upload.
 */
export type UploadPrecondition = { ifMatch: string } | { ifNoneMatch: true };

const PARTS_URL = "/api/users/me/database/parts";

/** Every stored part, one after the other. Network failures throw. */
export async function downloadDatabase(token: string): Promise<DownloadResult> {
  return readDownload(await fetchParts(token, PARTS_URL));
}

/**
 * The stored part at `index`, counting from 0, as `parts`, with its sha256;
 * NOT_FOUND if there's no such part. Network failures throw.
 */
export async function downloadDatabasePart(token: string, index: number): Promise<DownloadResult> {
  return readDownload(await fetchParts(token, `${PARTS_URL}/${index}`));
}

function fetchParts(token: string, url: string) {
  return fetch(url, { headers: { Authorization: `Bearer ${token}` } });
}

async function readDownload(res: Response): Promise<DownloadResult> {
  if (res.status === 404) return { success: false, code: "NOT_FOUND" };
  if (res.status === 401) return { success: false, code: "UNAUTHORIZED" };
  const sha256 = parseEtag(res.headers.get("ETag"));
  if (!res.ok || sha256 === undefined) return { success: false, code: "DOWNLOAD_FAILED" };

  return { success: true, parts: new Uint8Array(await res.arrayBuffer()), sha256 };
}

/** Replaces every stored part with `parts`, one after the other. Network failures throw. */
export function replaceDatabase(
  token: string,
  parts: Uint8Array<ArrayBuffer>,
  precondition: UploadPrecondition,
): Promise<UploadResult> {
  return upload("PUT", token, parts, {
    ...("ifMatch" in precondition
      ? { "If-Match": `"${precondition.ifMatch}"` }
      : { "If-None-Match": "*" }),
  });
}

/**
 * Adds `part` after the stored database's last part, whose sha256 `ifMatch`
 * must be. Network failures throw.
 */
export function appendDatabasePart(
  token: string,
  part: Uint8Array<ArrayBuffer>,
  ifMatch: string,
): Promise<UploadResult> {
  return upload("POST", token, part, { "If-Match": `"${ifMatch}"` });
}

async function upload(
  method: "PUT" | "POST",
  token: string,
  body: Uint8Array<ArrayBuffer>,
  headers: Record<string, string>,
): Promise<UploadResult> {
  const res = await fetch(PARTS_URL, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      ...headers,
    },
    body,
  });
  if (res.status === 412) return { success: false, code: "CONFLICT" };
  if (res.status === 401) return { success: false, code: "UNAUTHORIZED" };
  const sha256 = parseEtag(res.headers.get("ETag"));
  if (!res.ok || sha256 === undefined) return { success: false, code: "UPLOAD_FAILED" };

  return { success: true, sha256 };
}

/** The server sends the last part's sha256 as a strong ETag. */
function parseEtag(etag: string | null) {
  return /^"([0-9a-f]{64})"$/.exec(etag ?? "")?.[1];
}
