import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { openapi } from "./vite-plugins/openapi.ts";
import { opaqueWorkerd } from "./vite-plugins/opaqueWorkerd.ts";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    babel({ presets: [reactCompilerPreset()] }),
    openapi({ app: "./workers/spendy2/document.ts", fileName: "openapi.json" }),
    opaqueWorkerd(),
    cloudflare({ configPath: "./workers/spendy2/wrangler.jsonc" }),
  ],
  worker: { format: "es" },
});
