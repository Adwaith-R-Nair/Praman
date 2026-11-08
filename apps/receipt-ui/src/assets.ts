import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** A file the pages load by URL, read once at start. */
export interface Asset {
  readonly contentType: string;
  readonly body: string;
}

const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

/**
 * The console's grid and charts: AG Grid Community and AG Charts Community, both MIT.
 * Served from this app's own node_modules at exactly these versions, never from a CDN,
 * so the page's script-src stays 'self'. The versions here, in package.json and in the
 * served path must agree, or the server refuses to start. The grid is the noStyle
 * build: the full build adds the old CSS themes as <style> elements as it loads, with no
 * nonce, which the page's policy blocks. The theme the console uses is built at runtime
 * and carries the nonce.
 */
export const VENDOR = {
  grid: { pkg: "ag-grid-community", version: "36.2.0", file: "dist/ag-grid-community.min.noStyle.js" },
  charts: { pkg: "ag-charts-community", version: "14.2.0", file: "dist/umd/ag-charts-community.min.js" },
} as const;

export const vendorPath = (v: (typeof VENDOR)[keyof typeof VENDOR]): string => `/assets/vendor/${v.pkg}-${v.version}.min.js`;

function vendorFile(v: (typeof VENDOR)[keyof typeof VENDOR]): string {
  const dir = new URL(`../node_modules/${v.pkg}/`, import.meta.url);
  const pkg: unknown = JSON.parse(readFileSync(fileURLToPath(new URL("package.json", dir)), "utf8"));
  const installed = typeof pkg === "object" && pkg !== null && "version" in pkg ? pkg.version : null;
  if (installed !== v.version) throw new Error(`${v.pkg} ${String(installed)} is installed, but the console is pinned to ${v.version}. Run pnpm install.`);
  return readFileSync(fileURLToPath(new URL(v.file, dir)), "utf8");
}

/**
 * Every script and stylesheet the receipt pages use, by the path they are served at.
 * A fixed list, so a request path can only ever pick one of these and never names a
 * file. They are files rather than inline blocks so the Content-Security-Policy can
 * allow script and style from this origin only, with no 'unsafe-inline'.
 */
export const ASSETS: ReadonlyMap<string, Asset> = new Map([
  ["/assets/style.css", { contentType: "text/css; charset=utf-8", body: read("./style.css") }],
  ["/assets/landing.css", { contentType: "text/css; charset=utf-8", body: read("./landing.css") }],
  ["/assets/print.js", { contentType: "text/javascript; charset=utf-8", body: read("./layout.print.js") }],
  ["/assets/index.js", { contentType: "text/javascript; charset=utf-8", body: read("./pages/index.client.js") }],
  ["/assets/trace.js", { contentType: "text/javascript; charset=utf-8", body: read("./pages/trace.client.js") }],
  ["/assets/console.js", { contentType: "text/javascript; charset=utf-8", body: read("./console/console.client.js") }],
  ["/assets/console.css", { contentType: "text/css; charset=utf-8", body: read("./console/console.css") }],
  [vendorPath(VENDOR.grid), { contentType: "text/javascript; charset=utf-8", body: vendorFile(VENDOR.grid) }],
  [vendorPath(VENDOR.charts), { contentType: "text/javascript; charset=utf-8", body: vendorFile(VENDOR.charts) }],
]);
