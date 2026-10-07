import * as opaque from "@serenity-kit/opaque";
import { cancel, intro, isCancel, outro, text, group } from "@clack/prompts";
import fs from "fs";
import path from "path";

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
