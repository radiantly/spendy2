import path from "path";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { normalizePath, runnerImport, type Plugin } from "vite";

interface OpenAPIOptions {
  /** The app's module; see generateOpenAPIDocument. */
  app: string;
  /** The document's file name, and its path on the site. */
  fileName: string;
}

interface AppModule {
  default: OpenAPIHono;
  openAPIDocument: Omit<Parameters<OpenAPIHono["getOpenAPI31Document"]>[0], "openapi">;
}

/**
 * The OpenAPI document of `app`, a module, resolved against `root`, whose
 * default export is the app to document, and whose `openAPIDocument` export
 * is what the document says besides the routes. Also returns the files it
 * was generated from. The app is loaded in Node, so its modules must not
 * import `cloudflare:*`.
 */
export async function generateOpenAPIDocument(app: string, root: string) {
  const appPath = normalizePath(path.resolve(root, app));
  const { module, dependencies } = await runnerImport<AppModule>(appPath, { root });
  // the generator only copies `openapi` into the document; it's 3.1 for getOpenAPI31Document
  const document = { ...module.openAPIDocument, openapi: "3.1.0" };
  return {
    document: module.default.getOpenAPI31Document(document),
    // the dependencies leave out the module itself
    files: new Set([appPath, ...dependencies]),
  };
}

/** Serves the app's OpenAPI document in dev, and adds it to the client build. */
export function openapi({ app, fileName }: OpenAPIOptions): Plugin {
  let root = process.cwd();

  /** The document as JSON, and the files it was generated from. */
  async function generate() {
    const { document, files } = await generateOpenAPIDocument(app, root);
    return { json: JSON.stringify(document), files };
  }

  return {
    name: "openapi",

    configResolved(config) {
      root = config.root;
    },

    configureServer(server) {
      // generated when first requested, and again after its files change
      let generated: ReturnType<typeof generate> | undefined;
      let files = new Set<string>();

      server.watcher.on("all", (_event, file) => {
        if (files.has(normalizePath(file))) generated = undefined;
      });

      server.middlewares.use(async (req, res, next) => {
        if (req.url?.split("?")[0] !== `/${fileName}`) return next();

        const current = (generated ??= generate());
        try {
          const result = await current;
          files = result.files;
          res.setHeader("Content-Type", "application/json");
          res.end(result.json);
        } catch (error) {
          // retried on the next request
          if (generated === current) generated = undefined;
          server.config.logger.error(`Generating /${fileName} failed: ${error}`, {
            error: error instanceof Error ? error : undefined,
          });
          res.statusCode = 500;
          res.end(String(error));
        }
      });
    },

    async generateBundle() {
      if (this.environment.name !== "client") return;
      try {
        this.emitFile({ type: "asset", fileName, source: (await generate()).json });
      } catch (error) {
        this.error(`Generating ${fileName} failed: ${error}`);
      }
    },
  };
}
