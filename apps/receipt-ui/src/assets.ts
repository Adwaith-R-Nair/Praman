import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** A file the pages load by URL, read once at start. */
export interface Asset {
  readonly contentType: string;
  readonly body: string;
}

const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

/**
 * Every script and stylesheet the receipt pages use, by the path they are served at.
 * A fixed list, so a request path can only ever pick one of these and never names a
 * file. They are files rather than inline blocks so the Content-Security-Policy can
 * allow script and style from this origin only, with no 'unsafe-inline'.
 */
export const ASSETS: ReadonlyMap<string, Asset> = new Map([
  ["/assets/style.css", { contentType: "text/css; charset=utf-8", body: read("./style.css") }],
  ["/assets/print.js", { contentType: "text/javascript; charset=utf-8", body: read("./layout.print.js") }],
  ["/assets/index.js", { contentType: "text/javascript; charset=utf-8", body: read("./pages/index.client.js") }],
  ["/assets/trace.js", { contentType: "text/javascript; charset=utf-8", body: read("./pages/trace.client.js") }],
]);
