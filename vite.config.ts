import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { openapi } from "./vite-plugin-openapi.ts";
import pkg from "./package.json" with { type: "json" };

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    babel({ presets: [reactCompilerPreset()] }),
    openapi({
      app: "./worker/app.ts",
      fileName: "openapi.json",
      document: { info: { title: "Spendy API", version: pkg.version } },
    }),
    cloudflare(),
  ],
  worker: { format: "es" },
});
