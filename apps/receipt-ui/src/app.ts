import type { IncomingMessage, ServerResponse } from "node:http";
import { buildBundleStandalone } from "@praman/dispute";
import { ASSETS } from "./assets.js";
import { loadConsoleData } from "./console/data.js";
import { newStyleNonce, OPERATOR_CONSOLE_OFF, renderConsolePage } from "./console/page.js";
import { CONTENT_SECURITY_POLICY } from "./csp.js";
import { clientIp, LIMITS, RateLimiter } from "./demo/limits.js";
import { escapeHtml } from "./html.js";
import { layout } from "./layout.js";
import { renderIndexPage } from "./pages/index.js";
import { renderLandingPage } from "./pages/landing.js";
import { createSampleLoader, renderNoSamplePage, renderSamplePage } from "./pages/sample.js";
import { renderTracePage } from "./pages/trace.js";
import { sampleMandateIds } from "./sample-config.js";
import { verifyTrace } from "./verify.js";
import { handlePayPalWebhook, readRawBody, type PayPalWebhookDeps } from "./webhooks.js";

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export { CONTENT_SECURITY_POLICY } from "./csp.js";

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

export interface AppDeps {
  /** The /demo story, or null when this server has no demo key. */
  readonly demo: Handler | null;
  readonly webhooks: PayPalWebhookDeps;
  /** Sent on every response when the server is reached over HTTPS. */
  readonly hsts: boolean;
  /** How many proxies in front append to X-Forwarded-For (Render: 3, D-78). 0 reads the socket's address. */
  readonly proxyHops: number;
  readonly now?: () => Date;
  /** Told about every request to /demo, so the sweeps know the demo is in use. */
  readonly onDemoRequest: () => void;
  /** The demo's own origin, so a request the demo's origin check refuses doesn't spend the starts limit. */
  readonly demoOrigin?: string;
  readonly log: (line: string) => void;
  /**
   * The operator console at /console, which shows the whole ledger. Only on a local
   * server with the demo off: on the hosted demo it would show every visitor's
   * purchases. server.ts sets it; unset means off.
   */
  readonly operatorConsole?: boolean;
}

/** The newest rows the operator console shows. Older ones are on their trace pages. */
export const OPERATOR_CONSOLE_ROWS = 2000;

const text = (res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}) => {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...extra });
  res.end(body);
};

/** A browser that asked for a page gets one, with a way back to the demo. A script or Postman gets plain text. */
const wantsHtml = (req: IncomingMessage): boolean => (req.headers.accept ?? "").includes("text/html");

/** The front page never changes while the server runs, so it is rendered once. */
const LANDING = renderLandingPage();

function page(res: ServerResponse, status: number, title: string, message: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...extra });
  res.end(layout(title, `<h1 class="decision">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="/demo">Go to the demo</a> or <a href="/">read what Praman is</a>.</p>`, "home"));
}

/**
 * The trace id in a URL segment, or null when it can't be one: percent-encoding that
 * doesn't decode, or a control character, which no trace id has and Postgres text
 * can't hold (the same rule as the MCP gateway's id fields).
 */
function traceIdOf(segment: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  return /\p{Cc}/u.test(decoded) ? null : decoded;
}

/** A trace id as a download name: letters, digits, underscore and hyphen only. */
const fileNameOf = (traceId: string): string => traceId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120) || "trace";

/**
 * The receipt server's routes. Every response gets the security headers. /healthz
 * answers from memory, so an uptime ping never wakes the database.
 */
export function createApp(deps: AppDeps): Handler {
  const now = deps.now ?? (() => new Date());
  const starts = new RateLimiter(LIMITS.startPerIp.limit, LIMITS.startPerIp.windowMs);
  const reads = new RateLimiter(LIMITS.publicPerIp.limit, LIMITS.publicPerIp.windowMs);
  const deliveries = new RateLimiter(LIMITS.webhookPerIp.limit, LIMITS.webhookPerIp.windowMs);

  /** True if the request may go on. Otherwise it has been answered with a plain 429. */
  const within = (limiter: RateLimiter, req: IncomingMessage, res: ServerResponse, message: string): boolean => {
    const ip = clientIp(req, deps.proxyHops);
    const at = now();
    if (limiter.take(ip, at)) return true;
    const headers = { "Retry-After": limiter.retryAfterSeconds(ip, at).toString(), "Cache-Control": "no-store" };
    if (wantsHtml(req)) page(res, 429, "Too many requests", message, headers);
    else text(res, 429, message, headers);
    return false;
  };
  const TOO_MANY_READS = "Too many requests from your address in the last minute. Wait a minute and try again.";
  const sample = createSampleLoader(now);

  return async (req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    if (deps.hsts) res.setHeader("Strict-Transport-Security", "max-age=31536000");

    // A request target URL can't parse is the client's mistake. Thrown here, outside the
    // try below, it would reject the handler's promise and stop the whole process.
    const parsed = URL.canParse(req.url ?? "/", "http://localhost") ? new URL(req.url ?? "/", "http://localhost") : null;
    if (parsed === null) {
      text(res, 400, "Bad request");
      return;
    }
    const url = parsed;
    const method = req.method ?? "GET";
    const traceMatch = /^\/r\/([^/]+)\/?$/.exec(url.pathname);
    const verifyMatch = /^\/verify\/([^/]+)\/?$/.exec(url.pathname);
    const disputeMatch = /^\/dispute\/([^/]+)\/?$/.exec(url.pathname);

    try {
      if (url.pathname === "/healthz") {
        text(res, 200, "ok", { "Cache-Control": "no-store" });
        return;
      }

      const asset = method === "GET" || method === "HEAD" ? ASSETS.get(url.pathname) : undefined;
      if (asset !== undefined) {
        res.writeHead(200, { "Content-Type": asset.contentType, "Cache-Control": "public, max-age=300" });
        res.end(asset.body);
        return;
      }

      if (url.pathname === "/demo" || url.pathname.startsWith("/demo/")) {
        deps.onDemoRequest();
        const refusedOrigin = deps.demoOrigin !== undefined && req.headers.origin !== undefined && req.headers.origin !== deps.demoOrigin;
        if (method === "POST" && !refusedOrigin && url.pathname.replace(/\/+$/, "") === "/demo/start" && !within(starts, req, res, "Too many new demo sessions from your address. Wait ten minutes, or carry on with the session you have at /demo.")) return;
        if (deps.demo === null) {
          text(res, 503, "The demo isn't configured on this server.");
          return;
        }
        await deps.demo(req, res);
        return;
      }

      if (url.pathname === "/console" || url.pathname === "/console/data") {
        if (method !== "GET" && method !== "HEAD") {
          text(res, 405, "Method not allowed", { Allow: "GET, HEAD" });
          return;
        }
        if (deps.operatorConsole !== true) {
          text(res, 404, OPERATOR_CONSOLE_OFF, { "Cache-Control": "no-store" });
          return;
        }
        if (!within(reads, req, res, TOO_MANY_READS)) return;
        if (url.pathname === "/console/data") {
          const data = await loadConsoleData({ kind: "all", limit: OPERATOR_CONSOLE_ROWS }, new Map(), now());
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(JSON.stringify(data));
          return;
        }
        const page = renderConsolePage("operator", newStyleNonce());
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": page.policy });
        res.end(page.html);
        return;
      }

      if (url.pathname === "/webhooks/paypal") {
        if (method !== "POST") {
          text(res, 405, "Method not allowed", { Allow: "POST" });
          return;
        }
        if (!within(deliveries, req, res, "Too many deliveries from this address.")) return;
        const rawBody = await readRawBody(req);
        const reply = rawBody === null ? { status: 413, body: "too large" } : await handlePayPalWebhook(rawBody, req.headers, deps.webhooks);
        text(res, reply.status, reply.body);
        return;
      }

      if (method !== "GET" && method !== "HEAD") {
        text(res, 405, "Method not allowed", { Allow: "GET, HEAD" });
        return;
      }

      // The front page is fixed text and reads nothing, so it answers even with the database asleep.
      if (url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" });
        res.end(LANDING);
        return;
      }

      // The public sample: one past session, named in server configuration and nowhere else.
      // Read-only, and it serves only what a public trace page and bundle already do (D-84).
      const samplePath = url.pathname.replace(/\/+$/, "");
      if (samplePath === "/sample" || samplePath === "/sample/data") {
        const mandateIds = sampleMandateIds();
        if (mandateIds.length === 0) {
          if (samplePath === "/sample") {
            res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
            res.end(renderNoSamplePage());
          } else {
            res.writeHead(404, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
            res.end(JSON.stringify({ error: "no sample" }));
          }
          return;
        }
        if (!within(reads, req, res, TOO_MANY_READS)) return;
        const view = await sample(mandateIds);
        if (samplePath === "/sample/data") {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(JSON.stringify(view.data));
          return;
        }
        const page = renderSamplePage(view.traces, newStyleNonce());
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": page.policy });
        res.end(page.html);
        return;
      }

      const rawTraceId = traceMatch?.[1] ?? verifyMatch?.[1] ?? disputeMatch?.[1];
      if (rawTraceId !== undefined && traceIdOf(rawTraceId) === null) {
        if (wantsHtml(req)) page(res, 404, "No such trace", "There is no trace at this address.");
        else text(res, 404, "Not found");
        return;
      }

      const isIndex = url.pathname === "/traces" || url.pathname === "/traces/";
      // Each of these reads the database, and they are open to anyone with a trace id.
      if ((traceMatch?.[1] || verifyMatch?.[1] || disputeMatch?.[1] || isIndex) && !within(reads, req, res, TOO_MANY_READS)) return;

      if (traceMatch?.[1]) {
        const { status, html } = await renderTracePage(traceIdOf(traceMatch[1]) ?? "");
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (verifyMatch?.[1]) {
        const result = await verifyTrace(traceIdOf(verifyMatch[1]) ?? "");
        res.writeHead(result ? 200 : 404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
        return;
      }

      if (disputeMatch?.[1]) {
        const traceId = traceIdOf(disputeMatch[1]) ?? "";
        const bundle = await buildBundleStandalone(traceId);
        if (!bundle) {
          text(res, 404, "Not found");
          return;
        }
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${fileNameOf(traceId)}.json"`,
        });
        res.end(JSON.stringify(bundle, null, 2));
        return;
      }

      if (isIndex) {
        // The index never lists demo visitors' traces. With none to list it says so and
        // links to the demo. Rendered before the status goes out, so a failure is still a 500.
        const html = await renderIndexPage(sampleMandateIds().length > 0);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (wantsHtml(req)) page(res, 404, "Page not found", "There is nothing at this address.");
      else text(res, 404, "Not found");
    } catch (err) {
      // The operator log gets the error. The visitor gets no stack trace and no
      // message: an error's text can carry a query, a URL or a provider's reply.
      deps.log(`receipt-ui: ${method} ${url.pathname} failed: ${err instanceof Error ? `${err.name}: ${err.message}` : "unknown error"}`);
      const failed = "Something went wrong on this server. The error is logged. Try again in a moment.";
      if (res.headersSent) res.end();
      else if (wantsHtml(req)) page(res, 500, "Something went wrong", failed);
      else text(res, 500, failed);
    }
  };
}
