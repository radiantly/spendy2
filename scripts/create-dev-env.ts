import * as opaque from "@serenity-kit/opaque";
import { cancel, intro, outro, password, text, group } from "@clack/prompts";
import fs from "fs";
import path from "path";

function required(value?: string) {
  if (!value) return "Required";
}

intro(`Create dev .env`);

await opaque.ready;

const dotenv = await group(
  {
    OPAQUE_SERVER_SETUP: () =>
      text({
        message: "Opaque server sercret?",
        placeholder: "generate new",
        defaultValue: opaque.server.createSetup(),
      }),
    S3_ENDPOINT: () =>
      text({
        message: "S3 endpoint?",
        placeholder: "https://s3.us-west-004.backblazeb2.com",
        validate: (value) => {
          if (!value || !URL.canParse(value)) return "Must be a URL";
        },
      }),
    S3_REGION: () =>
      text({
        message: "S3 region?",
        placeholder: "us-west-004",
        validate: required,
      }),
    S3_BUCKET: () =>
      text({
        message: "S3 bucket?",
        validate: required,
      }),
    S3_ACCESS_KEY_ID: () =>
      text({
        message: "S3 access key id?",
        validate: required,
      }),
    S3_SECRET_ACCESS_KEY: () =>
      password({
        message: "S3 secret access key?",
        validate: required,
      }),
  },
  {
    onCancel: () => {
      cancel("Aborted");
      process.exit(0);
    },
  },
);

const dotenv_content = Object.entries(dotenv)
  .map(([key, value]) => `${key}=${value}`)
  .join("\n");

const dotenv_path = path.join(import.meta.dirname, "..", ".env");
fs.writeFileSync(dotenv_path, dotenv_content);

outro(`You're all set!`);
