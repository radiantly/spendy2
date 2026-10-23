import { defineConfig } from "vite";
import { scalar } from "./vite-plugin-scalar.ts";

// https://vite.dev/config/
export default defineConfig({
  plugins: [scalar({ app: "../worker/document.ts", wrangler: "../wrangler.jsonc" })],
});
