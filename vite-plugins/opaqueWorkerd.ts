import fs from "fs";
import { createRequire } from "module";
import path from "path";
import type { Plugin } from "vite";

const PACKAGE = "@serenity-kit/opaque";

/**
 * How the package's bundle gets its wasm: as base64 in this one function,
 * compiled when the module loads. That's as its bundler (@rollup/plugin-wasm)
 * writes it, so a release may change it; then this must follow.
 */
const INLINED_WASM =
  /function wasmData\(imports\)\{return _loadWasmModule\(0, null, '([A-Za-z0-9+/=]+)'\)\}/;

const WASM_FILE = "opaque_bg.wasm";

function writeIfChanged(file: string, content: Buffer) {
  if (fs.existsSync(file) && fs.readFileSync(file).equals(content)) return;
  fs.writeFileSync(file, content);
}

/**
 * Makes a build of @serenity-kit/opaque that Cloudflare Workers can run, in
 * `directory`, and returns its entry module's path.
 *
 * Workers don't compile wasm from bytes, which is what the package's own
 * builds do with the wasm they hold as base64. This build is the package's,
 * with the wasm as a file beside it that it imports as a module instead.
 */
export function buildOpaqueForWorkerd(directory: string): string {
  const require = createRequire(import.meta.url);
  const source = fs.readFileSync(require.resolve(`${PACKAGE}/esm/index.js`), "utf8");
  const inlined = INLINED_WASM.exec(source);
  if (!inlined)
    throw new Error(
      `${PACKAGE} no longer holds its wasm as vite-plugins/opaqueWorkerd.ts expects: see INLINED_WASM there`,
    );

  const entry = path.join(directory, "index.js");
  fs.mkdirSync(directory, { recursive: true });
  writeIfChanged(path.join(directory, WASM_FILE), Buffer.from(inlined[1]!, "base64"));
  writeIfChanged(
    entry,
    Buffer.from(
      `import wasmModule from "./${WASM_FILE}";\n` +
        source.replace(INLINED_WASM, "function wasmData(){return wasmModule}"),
    ),
  );
  return entry;
}

/**
 * Has the worker import a build of @serenity-kit/opaque that it can run (see
 * buildOpaqueForWorkerd). The client keeps the package's own.
 */
export function opaqueWorkerd(): Plugin {
  let entry: string;

  return {
    name: "opaque-workerd",
    enforce: "pre",

    configResolved(config) {
      entry = buildOpaqueForWorkerd(
        path.join(config.root, "node_modules", ".cache", "opaque-workerd"),
      );
    },

    resolveId(id) {
      if (id === PACKAGE && this.environment.name !== "client") return entry;
    },
  };
}
