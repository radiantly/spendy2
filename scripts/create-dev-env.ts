import * as opaque from "@serenity-kit/opaque";
import { intro, outro, text, group } from "@clack/prompts";
import path from "path";
import { onCancel, readEnv, required, secret, url, writeEnv } from "./lib.ts";

const workerEnvPath = path.join(import.meta.dirname, "..", ".env");

intro(`Create dev .env`);

await opaque.ready;

const workerEnv = readEnv(workerEnvPath);

const newWorkerEnv = await group(
  {
    OPAQUE_SERVER_SETUP: () =>
      text({
        message: "Opaque server sercret?",
        placeholder: "generate new",
        initialValue: workerEnv.OPAQUE_SERVER_SETUP,
        defaultValue: opaque.server.createSetup(),
      }),
    S3_ENDPOINT: () =>
      text({
        message: "S3 endpoint?",
        placeholder: "https://s3.us-west-004.backblazeb2.com",
        initialValue: workerEnv.S3_ENDPOINT,
        validate: url,
      }),
    S3_REGION: () =>
      text({
        message: "S3 region?",
        placeholder: "us-west-004",
        initialValue: workerEnv.S3_REGION,
        validate: required,
      }),
    S3_BUCKET: () =>
      text({
        message: "S3 bucket?",
        initialValue: workerEnv.S3_BUCKET,
        validate: required,
      }),
    S3_ACCESS_KEY_ID: () =>
      text({
        message: "S3 access key id?",
        initialValue: workerEnv.S3_ACCESS_KEY_ID,
        validate: required,
      }),
    S3_SECRET_ACCESS_KEY: () =>
      secret("S3 secret access key?", workerEnv.S3_SECRET_ACCESS_KEY),
  },
  { onCancel },
);

writeEnv(workerEnvPath, newWorkerEnv);

outro(`You're all set!`);
