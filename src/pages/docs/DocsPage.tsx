import { DOCS_SITE } from "./docsSite.ts";

/**
 * The API reference, from the docs site. Being another origin, the site
 * can't reach the app's data, so it keeps its own (allow-same-origin): Scalar
 * needs its storage. The sandbox keeps it from navigating the app away,
 * which would drop unsaved changes.
 */
export default function DocsPage() {
  return (
    <iframe
      title="Spendy API reference"
      src={DOCS_SITE}
      sandbox="allow-scripts allow-same-origin allow-downloads allow-popups allow-popups-to-escape-sandbox"
      // for Scalar's copy buttons
      allow="clipboard-write"
      className="block min-h-0 w-full flex-1 border-0"
    />
  );
}
