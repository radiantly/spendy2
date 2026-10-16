import * as opaque from "@serenity-kit/opaque";
import { intro, outro, text, group } from "@clack/prompts";
import path from "path";
import { onCancel, readEnv, writeEnv } from "./lib.ts";

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
  },
  { onCancel },
);

writeEnv(workerEnvPath, newWorkerEnv);

outro(`You're all set!`);
