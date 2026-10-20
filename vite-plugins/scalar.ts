import { createHash } from "crypto";
import fs from "fs";
import { createRequire } from "module";
import path from "path";
import {
  generateBodyScript,
  getJsAsset,
  renderApiReferenceToString,
} from "@scalar/server-side-rendering";
import { normalizePath, type Plugin, type ViteDevServer } from "vite";
import { experimental_readRawConfig, type Unstable_RawConfig } from "wrangler";
import { generateOpenAPIDocument } from "./openapi.ts";

interface ScalarOptions {
  /** The app's module, relative to the root; see generateOpenAPIDocument. */
  app: string;
  /** The app's Wrangler config, relative to the root; its routes are where the API is. */
  wrangler: string;
}

/**
 * The API client and test requests are hidden: they'd send requests from
 * this site, and the API allows no other origins. Scalar's fonts aren't
 * loaded, so the page makes no requests to other sites. Every tag starts
 * open: by default only the first does, and only when the URL names no
 * section, which the pre-rendered page can't know.
 */
const SCALAR_OPTIONS = {
  hideClientButton: true,
  hideTestRequestButton: true,
  hideDarkModeToggle: true,
  withDefaultFonts: false,
  defaultOpenAllTags: true,
};

/** Where index.html has the reference go. */
const APP = '<div id="app"></div>';

/** A file the page loads, named by its content's hash so it can be cached. */
interface Asset {
  fileName: string;
  contentType: string;
  source: string;
}

function asset(name: string, extension: "js" | "css", source: string): Asset {
  const hash = createHash("sha256").update(source).digest("base64url").slice(0, 8);
  return {
    fileName: `assets/${name}-${hash}.${extension}`,
    contentType: `text/${extension === "js" ? "javascript" : "css"}; charset=utf-8`,
    source,
  };
}

/**
 * Scalar's code, which hydrates the pre-rendered reference, and its styles.
 * Both come from the @scalar/api-reference the renderer uses, so they match
 * what it renders.
 */
function readScalarAssets() {
  const renderer = createRequire(import.meta.url).resolve("@scalar/server-side-rendering");
  const styles = createRequire(renderer).resolve("@scalar/api-reference/style.css");
  return {
    script: asset("scalar", "js", getJsAsset()),
    styles: asset("scalar", "css", fs.readFileSync(styles, "utf-8")),
  };
}

/**
 * Where the API is: the custom domains the app's Wrangler config routes it
 * to. Other routes are rejected, since their patterns, like
 * `example.com/api/*`, aren't URLs.
 */
function servers(wranglerPath: string) {
  // typed here, since Wrangler's types re-export the reader from a package it doesn't install
  const { rawConfig }: { rawConfig: Unstable_RawConfig } = experimental_readRawConfig({
    config: wranglerPath,
  });
  const routes = [...(rawConfig.route ? [rawConfig.route] : []), ...(rawConfig.routes ?? [])];
  if (routes.length === 0) throw new Error(`${wranglerPath} has no routes to the API`);
  return routes.map((route) => {
    if (typeof route === "string" || !route.custom_domain)
      throw new Error(`${wranglerPath} has a route that isn't a custom domain: ${route}`);
    return { url: `https://${route.pattern}` };
  });
}

/** `value` as JSON for an inline script: "<" is escaped so it can't end the script. */
function scriptJson(value: unknown) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

/**
 * Renders the app's API reference into index.html with Scalar, so the page
 * shows it before Scalar's code has loaded. That code then takes over the
 * page, to make it interactive.
 */
export function scalar({ app, wrangler }: ScalarOptions): Plugin {
  let root = process.cwd();
  let server: ViteDevServer | undefined;
  // read when first needed: Scalar's code is 4.6 MB
  let assets: ReturnType<typeof readScalarAssets> | undefined;
  // in dev, rendered when first requested, and again after its files change
  let rendered: ReturnType<typeof render> | undefined;
  let files = new Set<string>();

  /** The reference, its configuration, and the files it was rendered from. */
  async function render() {
    const wranglerPath = normalizePath(path.resolve(root, wrangler));
    const { document, files } = await generateOpenAPIDocument(app, root);
    const configuration = { content: document, servers: servers(wranglerPath), ...SCALAR_OPTIONS };
    return {
      html: await renderApiReferenceToString(configuration),
      configuration,
      files: new Set([...files, wranglerPath]),
    };
  }

  return {
    name: "scalar",

    configResolved(config) {
      root = config.root;
    },

    configureServer(devServer) {
      server = devServer;

      devServer.watcher.on("all", (_event, file) => {
        if (!files.has(normalizePath(file))) return;
        rendered = undefined;
        devServer.ws.send({ type: "full-reload" });
      });

      devServer.middlewares.use((req, res, next) => {
        assets ??= readScalarAssets();
        const asset = [assets.script, assets.styles].find(
          ({ fileName }) => req.url?.split("?")[0] === `/${fileName}`,
        );
        if (!asset) return next();
        res.setHeader("Content-Type", asset.contentType);
        res.end(asset.source);
      });
    },

    transformIndexHtml: {
      // after Vite's own processing, which would try to bundle Scalar's script
      order: "post",
      async handler(html) {
        if (!html.includes(APP)) throw new Error(`index.html has no ${APP} for the reference`);

        const current = (rendered ??= render());
        let reference: Awaited<typeof current>;
        try {
          reference = await current;
        } catch (error) {
          // retried on the next request
          if (rendered === current) rendered = undefined;
          throw error;
        }
        files = reference.files;
        // they're outside the root, which is all Vite watches
        server?.watcher.add([...files]);

        assets ??= readScalarAssets();
        return {
          // a function, so `$` in the reference isn't a replacement pattern
          html: html.replace(
            APP,
            () =>
              `${generateBodyScript(reference.configuration)}<div id="app">${reference.html}</div>`,
          ),
          tags: [
            {
              tag: "link",
              attrs: { rel: "stylesheet", href: `/${assets.styles.fileName}` },
              injectTo: "head",
            },
            { tag: "script", attrs: { src: `/${assets.script.fileName}` }, injectTo: "body" },
            {
              tag: "script",
              children: `Scalar.createApiReference("#app", ${scriptJson(reference.configuration)})`,
              injectTo: "body",
            },
          ],
        };
      },
    },

    generateBundle() {
      assets ??= readScalarAssets();
      for (const { fileName, source } of [assets.script, assets.styles])
        this.emitFile({ type: "asset", fileName, source });
    },
  };
}
