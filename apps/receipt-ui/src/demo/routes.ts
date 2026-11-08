import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { loadRecording, refundControlHtml, renderCheckoutReturnPage, renderDemoPage, renderErrorPage, renderRecordedRunPage, renderStartPage } from "../pages/demo.js";
import { renderTracePage } from "../pages/trace.js";
import { loadConsoleData, type Budget } from "../console/data.js";
import { newStyleNonce, renderConsolePage } from "../console/page.js";
import { SESSION_TTL_MS, type BeatId, type PurchaseBeat } from "./config.js";
import { finishConnect, releaseSession, startConnect, type DemoDeps } from "./connect.js";
import { LIMITS, RateLimiter } from "./limits.js";
import type { DemoSession } from "./session.js";
import { captureCheckout, decideApproval, refundPurchase, runBeat } from "./story.js";

export const COOKIE = "praman_demo";
const CLIENT_JS = readFileSync(fileURLToPath(new URL("./client.js", import.meta.url)), "utf8");
const DEMO_CSS = readFileSync(fileURLToPath(new URL("./demo.css", import.meta.url)), "utf8");

/** A screenshot of one complete session, served as the recorded run once the day's sessions are used up. */
const RECORDED_RUN_PNG = readFileSync(fileURLToPath(new URL("../../../../docs/screenshots/demo-story-desktop.png", import.meta.url)));

/** Told to a visitor whose session is gone, whatever they had pressed. */
const SESSION_ENDED =
  "Your demo session has ended, because the server restarted or its hour ran out. Whatever you just pressed was not run. A PayPal checkout that wasn't captured can't be captured now, so nothing is charged for it. Everything already paid stays on the ledger. Start a new session to go on.";

const STEPS: readonly BeatId[] = ["first", "second", "large", "injection", "fixture", "concurrency", "revoke", "after_revoke"];
/** The steps that buy at the cafe. Any of them can need approval or become a checkout. */
const PURCHASES: readonly PurchaseBeat[] = ["first", "second", "large"];

function isStep(value: string, allowed: readonly BeatId[]): value is BeatId {
  return allowed.some((s) => s === value);
}

function isPurchase(value: string): value is PurchaseBeat {
  return PURCHASES.some((s) => s === value);
}

/** The session's two mandates and their signed budgets: the only rows its console may show. */
function consoleScope(session: DemoSession): { readonly mandateIds: string[]; readonly budgets: Map<string, Budget> } {
  const budgets = new Map<string, Budget>();
  for (const m of [session.mandate, session.harnessMandate]) {
    const doc = m.document;
    if (doc.version === 2) budgets.set(doc.mandate_id, { maxTotalMinor: doc.limits.max_total_minor, currency: doc.scope.currency });
  }
  return { mandateIds: [session.mandate.document.mandate_id, session.harnessMandate.document.mandate_id], budgets };
}

function readCookie(header: string | undefined): string | null {
  if (header === undefined) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=") || null;
  }
  return null;
}

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
};

/**
 * The demo's routes, all under /demo. A visitor is their session cookie. Every route
 * acts on that session's own mandate, approvals, orders and saved PayPal method, and
 * nothing else: no route reads a request body, and the only query value read is
 * PayPal's own token on the way back from approval, which must match the session's.
 * So a request can't name a price, currency, rail, merchant, goal, approval or trace.
 * A refund is asked for by step, /demo/refund/<step>, and acts on that step's purchase.
 */
export function createDemoHandler(deps: DemoDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const secure = deps.baseUrl.startsWith("https://");
  const origin = new URL(deps.baseUrl).origin;
  const recording = loadRecording();
  const presses = new RateLimiter(LIMITS.postsPerSession.limit, LIMITS.postsPerSession.windowMs);
  // Each console load walks the whole chain, so it is limited per session like a press.
  const consoleLoads = new RateLimiter(LIMITS.postsPerSession.limit, LIMITS.postsPerSession.windowMs);

  const send = (res: ServerResponse, status: number, html: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS, ...extra });
    res.end(html);
  };
  const redirect = (res: ServerResponse, location: string, extra: Record<string, string> = {}) => {
    res.writeHead(303, { Location: location, ...SECURITY_HEADERS, ...extra });
    res.end();
  };
  const cookie = (value: string, maxAgeSeconds: number) =>
    `${COOKIE}=${value}; Path=/demo; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds.toString()}${secure ? "; Secure" : ""}`;

  /** One step at a time per session. A second click while one runs is refused, not queued. */
  async function exclusive<T>(session: DemoSession, work: () => Promise<T>): Promise<T | null> {
    if (session.busy) {
      session.notice = "A step is still running. Its result will show when it finishes.";
      return null;
    }
    session.busy = true;
    try {
      return await work();
    } finally {
      session.busy = false;
    }
  }

  return async (req, res) => {
    const url = new URL(req.url ?? "/demo", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/demo";
    const method = req.method ?? "GET";
    const now = deps.now();

    try {
      if (path === "/demo/client.js" && method === "GET") {
        res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", ...SECURITY_HEADERS });
        res.end(CLIENT_JS);
        return;
      }
      if (path === "/demo/demo.css" && method === "GET") {
        res.writeHead(200, { "Content-Type": "text/css; charset=utf-8", ...SECURITY_HEADERS });
        res.end(DEMO_CSS);
        return;
      }

      if (path === "/demo/recorded" && method === "GET") {
        send(res, 200, renderRecordedRunPage(url.searchParams.get("reason") === "sessions"));
        return;
      }
      if (path === "/demo/recorded-run.png" && method === "GET") {
        res.writeHead(200, { "Content-Type": "image/png", ...SECURITY_HEADERS, "Cache-Control": "public, max-age=3600" });
        res.end(RECORDED_RUN_PNG);
        return;
      }

      // A cross-site form can't act for a visitor. SameSite=Lax already withholds the
      // cookie; this refuses the request outright when a browser says where it came from.
      const from = req.headers.origin;
      if (method === "POST" && from !== undefined && from !== origin) {
        send(res, 403, renderErrorPage());
        return;
      }

      const session = deps.sessions.get(readCookie(req.headers.cookie), now);
      const configured = { paypal: deps.paypal !== null, model: deps.provider !== null };

      if (method === "GET" && (path === "/demo/checkout/return" || path === "/demo/checkout/cancel")) {
        // Usually opened in a private window or another browser, with no session, so it says what to do and does nothing.
        if (session !== null) {
          session.notice = path.endsWith("cancel") ? "You cancelled at PayPal. Nothing was charged." : "PayPal has your approval. Press Capture the payment to finish.";
          redirect(res, "/demo");
          return;
        }
        send(res, 200, renderCheckoutReturnPage(path.endsWith("cancel")));
        return;
      }

      if (method === "POST" && path === "/demo/start") {
        // Shared by every visitor and kept in the database, so a restart doesn't refill it.
        // Past the cap the visitor still sees the whole story, as a labelled recording (D-61).
        if (!(await deps.usage.take("session", now))) {
          redirect(res, "/demo/recorded?reason=sessions");
          return;
        }
        if (session !== null) {
          deps.sessions.end(session.id);
          await releaseSession(session, deps);
        }
        const fresh = deps.sessions.create(now);
        redirect(res, "/demo", { "Set-Cookie": cookie(fresh.id, Math.floor(SESSION_TTL_MS / 1000)) });
        return;
      }

      if (method === "GET" && path === "/demo/console") {
        const page = renderConsolePage("visitor", newStyleNonce(), session === null ? "You have no demo session in this browser, so there are no rows to show. Start a session on the demo page, then come back." : null);
        send(res, 200, page.html, { "Content-Security-Policy": page.policy });
        return;
      }
      if (method === "GET" && path === "/demo/console/data") {
        const json = { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS };
        if (session === null) {
          res.writeHead(401, json);
          res.end(JSON.stringify({ error: "no session" }));
          return;
        }
        if (!consoleLoads.take(session.ref, now)) {
          res.writeHead(429, { ...json, "Retry-After": consoleLoads.retryAfterSeconds(session.ref, now).toString() });
          res.end(JSON.stringify({ error: "too many loads" }));
          return;
        }
        const scope = consoleScope(session);
        const data = await loadConsoleData({ kind: "mandates", mandateIds: scope.mandateIds }, scope.budgets, now);
        res.writeHead(200, json);
        res.end(JSON.stringify(data));
        return;
      }

      if (session === null) {
        if (method === "GET" && path === "/demo") {
          // A cookie this server doesn't know: a restart or the hour's end. Said once, then forgotten.
          const hadSession = readCookie(req.headers.cookie) !== null;
          send(res, 200, renderStartPage(hadSession ? SESSION_ENDED : null, configured), hadSession ? { "Set-Cookie": cookie("", 0) } : {});
          return;
        }
        if (method === "GET" && path.startsWith("/demo/connect/")) {
          send(res, 200, renderStartPage("Your session ended before PayPal sent you back. Nothing was saved. Start a new session.", configured));
          return;
        }
        // Nothing to act on. A stale cookie gets the start page, which says what happened.
        redirect(res, "/demo");
        return;
      }

      // Button presses per session. A person clicking through the story never gets near it.
      if (method === "POST" && !presses.take(session.ref, now)) {
        res.writeHead(429, { "Content-Type": "text/plain; charset=utf-8", "Retry-After": presses.retryAfterSeconds(session.ref, now).toString(), ...SECURITY_HEADERS });
        res.end("Too many presses in this session in the last minute. Wait a minute, then go back to /demo. Nothing you pressed was run twice.");
        return;
      }

      if (method === "GET" && path === "/demo") {
        const html = renderDemoPage(session, recording, configured);
        session.notice = null;
        send(res, 200, html);
        return;
      }

      if (method === "POST" && path === "/demo/end") {
        deps.sessions.end(session.id);
        await releaseSession(session, deps);
        redirect(res, "/demo", { "Set-Cookie": cookie("", 0) });
        return;
      }

      if (method === "POST" && path === "/demo/connect") {
        const location = await exclusive(session, () => startConnect(session, deps));
        redirect(res, location ?? "/demo#connect");
        return;
      }

      if (method === "GET" && path === "/demo/connect/return") {
        await exclusive(session, () => finishConnect(session, url.searchParams.get("approval_token_id"), deps));
        redirect(res, "/demo#connect");
        return;
      }

      if (method === "GET" && path === "/demo/connect/cancel") {
        session.notice = "You cancelled at PayPal. Nothing was saved.";
        redirect(res, "/demo#connect");
        return;
      }

      const [, , verb, name] = path.split("/");

      // The visitor's own view of a purchase step's trace: the public trace page, plus
      // the refund control for this session's purchase. The path names a step, never a trace.
      if (method === "GET" && verb === "r" && name !== undefined && isPurchase(name)) {
        const record = session.beats.get(name);
        if (record === undefined || record.traceId === null) {
          redirect(res, "/demo");
          return;
        }
        const notice = session.notice;
        session.notice = null;
        const page = await renderTracePage(record.traceId, (trace) => refundControlHtml(name, record, trace, notice));
        send(res, page.status, page.html);
        return;
      }

      if (method === "POST" && name !== undefined) {
        if (verb === "step" && isStep(name, STEPS)) {
          await exclusive(session, () => runBeat(session, name, deps));
          redirect(res, `/demo#${name === "fixture" ? "injection" : name === "after_revoke" ? "revoke" : name}`);
          return;
        }
        if ((verb === "approve" || verb === "reject") && isPurchase(name)) {
          await exclusive(session, () => decideApproval(session, name, verb, deps));
          redirect(res, `/demo#${name}`);
          return;
        }
        if (verb === "capture" && isPurchase(name)) {
          await exclusive(session, () => captureCheckout(session, name, deps));
          redirect(res, `/demo#${name}`);
          return;
        }
        if (verb === "refund" && isPurchase(name)) {
          // Only a person on this session's page gets here: no agent can reach this route (D-66).
          await exclusive(session, () => refundPurchase(session, name, deps));
          redirect(res, (session.beats.get(name)?.traceId ?? null) === null ? `/demo#${name}` : `/demo/r/${name}#refund`);
          return;
        }
      }

      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
      res.end("Not found");
    } catch (err) {
      // The visitor gets a plain page. The operator gets the error's name and message,
      // which on this path never carry a token or a cookie.
      deps.log(`demo: ${method} ${path} failed: ${err instanceof Error ? `${err.name}: ${err.message}` : "unknown error"}`);
      if (!res.headersSent) send(res, 500, renderErrorPage());
      else res.end();
    }
  };
}

/** Ends every expired session and gives up its saved PayPal method. Run on an interval. */
export async function sweepExpiredSessions(deps: DemoDeps): Promise<number> {
  const expired = deps.sessions.purgeExpired(deps.now());
  for (const session of expired) await releaseSession(session, deps);
  return expired.length;
}

/**
 * For a graceful shutdown: ends every session and asks PayPal to delete every saved
 * payment method, all at once, waiting at most `timeoutMs`. Best effort. Tokens live
 * only in this process's memory (D-50), so a crash or a kill loses them here while
 * PayPal keeps them, still usable with this app's credentials, until someone deletes
 * them in the sandbox. Nothing here logs a token.
 */
export async function releaseAllSessions(deps: DemoDeps, timeoutMs: number): Promise<{ sessions: number; deleted: number; notDeleted: number }> {
  const sessions = deps.sessions.endAll();
  for (const session of sessions) session.connected = false;
  const tokens = deps.savedMethods.takeAll();
  if (tokens.length === 0) return { sessions: sessions.length, deleted: 0, notDeleted: 0 };
  if (deps.paypal === null) {
    deps.log(`demo: shutdown: ${tokens.length.toString()} saved PayPal methods dropped; no PayPal credentials to delete them with`);
    return { sessions: sessions.length, deleted: 0, notDeleted: tokens.length };
  }
  const vault = deps.paypal.vault;
  let deleted = 0;
  const attempts = tokens.map(async (tokenId) => {
    try {
      if ((await vault.deletePaymentToken(tokenId)).ok) deleted += 1;
    } catch {
      // Counted below as not deleted. The error's text could come from PayPal, so it isn't logged.
    }
  });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([Promise.all(attempts), timeout]);
  clearTimeout(timer);
  const notDeleted = tokens.length - deleted;
  deps.log(`demo: shutdown: deleted ${deleted.toString()} of ${tokens.length.toString()} saved PayPal methods at PayPal${notDeleted > 0 ? `; ${notDeleted.toString()} not confirmed and may still exist there` : ""}`);
  return { sessions: sessions.length, deleted, notDeleted };
}
