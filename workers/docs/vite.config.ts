import { defineConfig } from "vite";
import { scalar } from "./vite-plugin-scalar.ts";

// https://vite.dev/config/
export default defineConfig({
  plugins: [scalar({ app: "../spendy2/document.ts", wrangler: "../spendy2/wrangler.jsonc" })],
});
