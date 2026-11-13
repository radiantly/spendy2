import { utf8, type AssetEntry } from "../format.ts";
import type { Served } from "./helpers.ts";

const API = "https://api.cloudflare.com/client/v4";
const ORIGIN = "https://currency.spendy2.com";
const SCRIPT = "/accounts/account/workers/scripts/currency";
const UPLOAD = "/client/v4/accounts/account/workers/assets/upload";

/** A JWT with these claims, as far as anything here reads one: base64url, unpadded. */
function jwt(claims: Record<string, unknown>) {
  const payload = utf8(JSON.stringify(claims)).toBase64({
    alphabet: "base64url",
    omitPadding: true,
  });
  return `header.${payload}.signature`;
}

function result(value: unknown) {
  return Response.json({ success: true, errors: [], messages: [], result: value });
}

function refusal(status: number, message: string) {
  return Response.json(
    { success: false, errors: [{ code: 10000, message }], messages: [], result: null },
    { status },
  );
}

/** A step of a deploy, to have fail. */
export type Step = "session" | "upload" | "deploy";

/** An upload under way: the hashes Cloudflare is still without, and its tokens. */
type Session = {
  manifest: Record<string, AssetEntry>;
  missing: Set<string>;
  token: string;
  /** The token to deploy with, once nothing is missing. */
  completion: string;
};

/**
 * Stands in for everything the update talks to: the currency worker's
 * origin, serving `served`; Frankfurter, answering with `rates`; and
 * Cloudflare's API for the account `account` and the script `currency`,
 * where a deploy changes what is served. Stub `fetch` with its `fetch`.
 *
 * The API is as strict as the real one about the order of a deploy and its
 * tokens, and refuses as it would. It doesn't check a file against its hash:
 * neither does Cloudflare.
 */
export class FakeCloud {
  /** What the currency worker serves. */
  served: Served;
  /** The requests made, as `METHOD url`, in order. */
  requests: string[] = [];
  /** Each request's Authorization header, in the same order. */
  authorizations: (string | null)[] = [];

  /** What Frankfurter answers with: the body, as JSON, of a 200. */
  rates: unknown = [];
  /** Frankfurter's status, when not 200. */
  ratesStatus = 200;
  /** Answers for Frankfurter in place of `rates`, when set: for a request's `from` and `to`. */
  frankfurter: ((from: string, to: string) => Response) | undefined;

  /** The most hashes a bucket has. */
  bucketSize = Infinity;
  /** Claims the session's token has besides its own. */
  sessionClaims: Record<string, unknown> = {};
  /** The steps to answer with a failure, and its status. */
  failing: Partial<Record<Step, number>> = {};
  /** Has the first upload to arrive answered only after every other. */
  firstUploadLast = false;
  /** Has no upload answered with the token to deploy with. */
  withholdCompletion = false;

  /** The hashes uploaded, in the order they were taken in. */
  uploaded: string[] = [];
  /** The Content-Type each uploaded file came with, by hash. */
  contentTypes = new Map<string, string>();
  /** The most uploads there were at one time. */
  uploadsAtOnce = 0;
  /** The deploys made. */
  deploys = 0;
  /** The last deploy's form: its parts' names, and its metadata. */
  lastDeploy: { parts: string[]; metadata: unknown } | undefined;

  /** Every file Cloudflare has, by hash: those served, and those uploaded since. */
  private blobs = new Map<string, Uint8Array<ArrayBuffer>>();
  private session: Session | undefined;
  private sessions = 0;
  private uploading = 0;
  /** The upload being held back for `firstUploadLast`: its hashes, and what lets it go. */
  private held: { hashes: Set<string>; release: () => void } | undefined;

  constructor(served: Served = new Map()) {
    this.served = served;
  }

  /** Has Cloudflare hold the served files by the hashes `assets` gives them. */
  know(assets: Record<string, AssetEntry>) {
    for (const [path, { hash }] of Object.entries(assets)) {
      const bytes = this.served.get(path);
      if (bytes !== undefined) this.blobs.set(hash, bytes);
    }
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    this.requests.push(`${request.method} ${request.url}`);
    this.authorizations.push(request.headers.get("Authorization"));
    const url = new URL(request.url);

    if (url.origin === ORIGIN) {
      const bytes = this.served.get(url.pathname);
      return bytes === undefined ? new Response(null, { status: 404 }) : new Response(bytes);
    }
    if (url.origin === "https://api.frankfurter.dev") {
      const { from = "", to = "" } = Object.fromEntries(url.searchParams);
      return this.frankfurter === undefined
        ? Response.json(this.rates, { status: this.ratesStatus })
        : this.frankfurter(from, to);
    }

    if (request.method === "POST" && request.url === `${API}${SCRIPT}/assets-upload-session`)
      return this.startSession(request);
    if (request.method === "POST" && url.pathname === UPLOAD) {
      this.uploading += 1;
      this.uploadsAtOnce = Math.max(this.uploadsAtOnce, this.uploading);
      try {
        return await this.upload(request);
      } finally {
        this.uploading -= 1;
      }
    }
    if (request.method === "PUT" && request.url === `${API}${SCRIPT}`) return this.deploy(request);
    throw new Error(`No fake for ${request.method} ${request.url}`);
  };

  private async startSession(request: Request) {
    if (this.failing.session !== undefined) return refusal(this.failing.session, "No session");
    if (request.headers.get("Authorization") !== "Bearer token")
      return refusal(403, "Authentication error");
    const { manifest } = await request.json<{ manifest: Record<string, AssetEntry> }>();
    const missing = [...new Set(Object.values(manifest).map(({ hash }) => hash))].filter(
      (hash) => !this.blobs.has(hash),
    );
    const buckets: string[][] = [];
    for (const hash of missing) {
      if (buckets.length === 0 || buckets.at(-1)!.length >= this.bucketSize) buckets.push([]);
      buckets.at(-1)!.push(hash);
    }
    this.sessions += 1;
    const token = jwt({ session: this.sessions, ...this.sessionClaims });
    this.session = {
      manifest,
      missing: new Set(missing),
      token,
      // With nothing to upload, the session's token is already it.
      completion: missing.length === 0 ? token : jwt({ session: this.sessions, complete: true }),
    };
    return result({ jwt: token, buckets });
  }

  private async upload(request: Request) {
    if (this.failing.upload !== undefined) return refusal(this.failing.upload, "No upload");
    const session = this.session;
    if (session === undefined || request.headers.get("Authorization") !== `Bearer ${session.token}`)
      return refusal(403, "Not the upload session's token");
    if (new URL(request.url).searchParams.get("base64") !== "true")
      return refusal(400, "Files must be base64");

    const files: [hash: string, bytes: Uint8Array<ArrayBuffer>, contentType: string][] = [];
    for (const [hash, file] of await request.formData()) {
      if (typeof file === "string") return refusal(400, `${hash} isn't a file`);
      if (!session.missing.has(hash)) return refusal(400, `${hash} wasn't asked for`);
      files.push([hash, Uint8Array.fromBase64(await file.text()), file.type]);
    }

    const hashes = new Set(files.map(([hash]) => hash));
    if (this.firstUploadLast && this.held === undefined && !session.missing.isSubsetOf(hashes)) {
      const { promise, resolve } = Promise.withResolvers<void>();
      this.held = { hashes, release: resolve };
      await promise;
    }
    for (const [hash, bytes, contentType] of files) {
      this.blobs.set(hash, bytes);
      this.contentTypes.set(hash, contentType);
      this.uploaded.push(hash);
      session.missing.delete(hash);
    }
    if (this.held !== undefined && session.missing.isSubsetOf(this.held.hashes))
      this.held.release();

    // Only the upload with the last file is answered with the token.
    return session.missing.size === 0 && !this.withholdCompletion
      ? result({ jwt: session.completion })
      : result(null);
  }

  private async deploy(request: Request) {
    if (this.failing.deploy !== undefined) return refusal(this.failing.deploy, "No deploy");
    if (request.headers.get("Authorization") !== "Bearer token")
      return refusal(403, "Authentication error");
    const form = await request.formData();
    const metadata = JSON.parse(String(form.get("metadata"))) as { assets?: { jwt?: string } };
    const session = this.session;
    if (
      session === undefined ||
      session.missing.size > 0 ||
      metadata.assets?.jwt !== session.completion
    )
      return refusal(400, "Not the token of a finished upload");

    const served: Served = new Map();
    for (const [path, { hash, size }] of Object.entries(session.manifest)) {
      const bytes = this.blobs.get(hash)!;
      if (bytes.length !== size) return refusal(400, `${path} isn't ${size} bytes`);
      served.set(path, bytes);
    }
    this.served = served;
    this.session = undefined;
    this.deploys += 1;
    this.lastDeploy = { parts: [...form.keys()], metadata };
    return result(null);
  }
}
