import { AwsClient } from "aws4fetch";

export class S3 {
  private readonly client;
  private readonly endpoint;
  private readonly bucket;
  constructor({
    S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY,
    S3_REGION,
    S3_BUCKET,
    S3_ENDPOINT,
  }: Record<
    | "S3_ACCESS_KEY_ID"
    | "S3_SECRET_ACCESS_KEY"
    | "S3_REGION"
    | "S3_BUCKET"
    | "S3_ENDPOINT",
    string
  >) {
    this.client = new AwsClient({
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
      service: "s3",
      region: S3_REGION,
      retries: 2,
    });
    this.endpoint = S3_ENDPOINT;
    this.bucket = S3_BUCKET;
  }

  async put(name: string, body: ArrayBuffer, sha256: string) {
    const response = await this.client.fetch(this.url(name), {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Amz-Content-Sha256": sha256,
        "X-Amz-Meta-Sha256": sha256,
      },
      body,
    });
    if (!response.ok) throw new S3Error(response);
  }

  async get(name: string) {
    const response = await this.client.fetch(this.url(name));
    if (response.status === 404) return;
    if (!response.ok || response.body === null) throw new S3Error(response);

    const sha256 = response.headers.get("X-Amz-Meta-Sha256");
    if (sha256 === null) throw new S3Error(response);

    return { body: response.body, sha256 };
  }

  private url(name: string) {
    return `${this.endpoint}/${this.bucket}/${encodeURIComponent(name)}`;
  }
}

export class S3Error extends Error {
  constructor(response: Response) {
    super(`Object storage responded with ${response.status}`);
    this.name = "S3Error";
  }
}
