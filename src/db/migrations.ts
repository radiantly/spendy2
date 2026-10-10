import { migrationsFromFiles } from "./migrate.ts";

/** The app's migrations, bundled from migrations/<version>.sql. */
export const MIGRATIONS = migrationsFromFiles(
  import.meta.glob<string>("./migrations/*.sql", { query: "?raw", import: "default", eager: true }),
);
