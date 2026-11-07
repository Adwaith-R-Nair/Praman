import type { IncomingMessage, ServerResponse } from "node:http";
import { buildBundleStandalone } from "@praman/dispute";
import { ASSETS } from "./assets.js";
import { countTraces } from "./data.js";
import { clientIp, LIMITS, RateLimiter } from "./demo/limits.js";
import { renderIndexPage } from "./pages/index.js";
import { renderTracePage } from "./pages/trace.js";
import { verifyTrace } from "./verify.js";
import { handlePayPalWebhook, readRawBody, type PayPalWebhookDeps } from "./webhooks.js";

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/**
 * Sent on every response. Script and style come only from this origin (and Google's
 * font stylesheet), nothing inline, so text that slips past escaping still can't run.
 * Forms may post here, and the demo's POSTs redirect on to PayPal's sandbox, which
 * form-action has to allow. No page may be framed.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self' https://www.sandbox.paypal.com",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

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
  /** Behind a proxy that sets X-Forwarded-For (Render), per-IP limits read the address from it. */
  readonly trustProxy: boolean;
  readonly now?: () => Date;
  /** Told about every request to /demo, so the sweeps know the demo is in use. */
  readonly onDemoRequest: () => void;
  readonly log: (line: string) => void;
}

const text = (res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}) => {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", ...extra });
  res.end(body);
};

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
    const ip = clientIp(req, deps.trustProxy);
    const at = now();
    if (limiter.take(ip, at)) return true;
    text(res, 429, message, { "Retry-After": limiter.retryAfterSeconds(ip, at).toString(), "Cache-Control": "no-store" });
    return false;
  };
  const TOO_MANY_READS = "Too many requests from your address in the last minute. Wait a minute and try again.";

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
        if (method === "POST" && url.pathname.replace(/\/+$/, "") === "/demo/start" && !within(starts, req, res, "Too many new demo sessions from your address. Wait ten minutes, or carry on with the session you have at /demo.")) return;
        if (deps.demo === null) {
          text(res, 503, "The demo isn't configured on this server.");
          return;
        }
        await deps.demo(req, res);
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

      // Each of these reads the database, and they are open to anyone with a trace id.
      if ((traceMatch?.[1] || verifyMatch?.[1] || disputeMatch?.[1] || url.pathname === "/") && !within(reads, req, res, TOO_MANY_READS)) return;

      if (traceMatch?.[1]) {
        const { status, html } = await renderTracePage(decodeURIComponent(traceMatch[1]));
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (verifyMatch?.[1]) {
        const result = await verifyTrace(decodeURIComponent(verifyMatch[1]));
        res.writeHead(result ? 200 : 404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
        return;
      }

      if (disputeMatch?.[1]) {
        const traceId = decodeURIComponent(disputeMatch[1]);
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

      if (url.pathname === "/") {
        // The index never lists demo visitors' traces, so on a fresh hosted database it
        // would always be empty. A visitor there is sent to the demo instead.
        if ((await countTraces()) === 0) {
          res.writeHead(302, { Location: "/demo" });
          res.end();
          return;
        }
        // Rendered before the status goes out, so a failure here is still a 500 page.
        const html = await renderIndexPage();
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      text(res, 404, "Not found");
    } catch (err) {
      // The operator log gets the error. The visitor gets no stack trace and no
      // message: an error's text can carry a query, a URL or a provider's reply.
      deps.log(`receipt-ui: ${method} ${url.pathname} failed: ${err instanceof Error ? `${err.name}: ${err.message}` : "unknown error"}`);
      if (!res.headersSent) text(res, 500, "Something went wrong on this server. The error is logged. Try again in a moment.");
      else res.end();
    }
  };
}
