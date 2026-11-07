import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { loadRecording, renderCheckoutReturnPage, renderDemoPage, renderErrorPage, renderStartPage } from "../pages/demo.js";
import { SESSION_TTL_MS, type BeatId, type PurchaseBeat } from "./config.js";
import { finishConnect, releaseSession, startConnect, type DemoDeps } from "./connect.js";
import type { DemoSession } from "./session.js";
import { captureCheckout, decideApproval, runBeat } from "./story.js";

export const COOKIE = "praman_demo";
const CLIENT_JS = readFileSync(fileURLToPath(new URL("./client.js", import.meta.url)), "utf8");

const STEPS: readonly BeatId[] = ["first", "second", "large", "injection", "fixture", "concurrency"];
/** The steps that buy at the cafe. Any of them can need approval or become a checkout. */
const PURCHASES: readonly PurchaseBeat[] = ["first", "second", "large"];

function isStep(value: string, allowed: readonly BeatId[]): value is BeatId {
  return allowed.some((s) => s === value);
}

function isPurchase(value: string): value is PurchaseBeat {
  return PURCHASES.some((s) => s === value);
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
 */
export function createDemoHandler(deps: DemoDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const secure = deps.baseUrl.startsWith("https://");
  const origin = new URL(deps.baseUrl).origin;
  const recording = loadRecording();

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
        if (session !== null) {
          deps.sessions.end(session.id);
          await releaseSession(session, deps);
        }
        const fresh = deps.sessions.create(now);
        redirect(res, "/demo", { "Set-Cookie": cookie(fresh.id, Math.floor(SESSION_TTL_MS / 1000)) });
        return;
      }

      if (session === null) {
        if (method === "GET" && path === "/demo") {
          send(res, 200, renderStartPage(null, configured));
          return;
        }
        if (method === "GET" && path.startsWith("/demo/connect/")) {
          send(res, 200, renderStartPage("Your session ended before PayPal sent you back. Nothing was saved. Start a new session.", configured));
          return;
        }
        // Nothing to act on. A stale cookie gets the start page, not an error.
        redirect(res, "/demo");
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
      if (method === "POST" && name !== undefined) {
        if (verb === "step" && isStep(name, STEPS)) {
          await exclusive(session, () => runBeat(session, name, deps));
          redirect(res, `/demo#${name === "fixture" ? "injection" : name}`);
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
