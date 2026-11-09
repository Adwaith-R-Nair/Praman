import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

/**
 * Regenerates docs/screenshots from a real run of the demo, at desktop and phone width.
 *
 *   pnpm screenshots                  the whole story, after connecting PayPal (see below)
 *   pnpm screenshots --front-only     the front page and the demo's start page: no PayPal, no model
 *
 * It starts the receipt server in this process on SCREENSHOT_PORT (default 4180) against
 * DATABASE_URL, runs every demo step against the PayPal sandbox and the real model, then
 * drives headless Chrome (CHROME, default google-chrome) to capture each page.
 *
 * The steps run in the page's order: the poisoned listing first, which needs no PayPal,
 * then the connection, the purchases, twenty at once and the revocation.
 *
 * Connecting PayPal needs a person at PayPal's sandbox login. The script prints PayPal's
 * link; log in there as the sandbox buyer, approve, then press Enter here. To skip that
 * next time, set PRAMAN_SAVED_PAYMENT_TOKEN_FILE to a path outside the repo: after a
 * connect the saved payment token is written there (mode 600), and later runs read it.
 * The token is never printed, logged, or put on a page or a ledger row. The large
 * purchase stops at PayPal's checkout link, because paying it needs that person too.
 *
 * The whole story spends sandbox money and about ten model calls. Nothing else.
 */

config({ path: fileURLToPath(new URL("../.env", import.meta.url)), quiet: true });

const PORT = Number(process.env["SCREENSHOT_PORT"] ?? 4180);
const BASE = `http://localhost:${PORT.toString()}`;
const REPO = fileURLToPath(new URL("../", import.meta.url));
const OUT = join(REPO, "docs", "screenshots");
const CHROME = process.env["CHROME"] ?? "google-chrome";
const FRONT_ONLY = process.argv.includes("--front-only");

const tokenFile = process.env["PRAMAN_SAVED_PAYMENT_TOKEN_FILE"] ? resolve(process.env["PRAMAN_SAVED_PAYMENT_TOKEN_FILE"]) : null;
if (tokenFile !== null && tokenFile.startsWith(REPO)) {
  console.error("PRAMAN_SAVED_PAYMENT_TOKEN_FILE must be outside the repo. A payment token can pay from the sandbox buyer's account.");
  process.exit(1);
}

function readToken(file: string): string | null {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  return typeof parsed === "object" && parsed !== null && "payment_token" in parsed && typeof parsed.payment_token === "string" ? parsed.payment_token : null;
}

const { createApp } = await import("../apps/receipt-ui/src/app.js");
const { payPalWebhookDepsFromEnv } = await import("../apps/receipt-ui/src/webhooks.js");
const { createDemoHandler } = await import("../apps/receipt-ui/src/demo/routes.js");
const { finishConnect, startConnect } = await import("../apps/receipt-ui/src/demo/connect.js");
const { demoDepsFromEnv } = await import("../apps/receipt-ui/src/demo/wiring.js");
const { seedDemoCatalog } = await import("../apps/receipt-ui/src/demo/seed.js");
const { decideApproval, runBeat } = await import("../apps/receipt-ui/src/demo/story.js");
const { prisma } = await import("@praman/db");

const wiring = demoDepsFromEnv({ ...process.env, DEMO_BASE_URL: BASE }, PORT);
if (!wiring.ok) {
  console.error(`The demo can't run: ${wiring.reason}`);
  process.exit(1);
}
const deps = wiring.deps;
if (!FRONT_ONLY && (deps.paypal === null || deps.provider === null)) {
  console.error("The story needs PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and GEMINI_API_KEY. Use --front-only to shoot the pages that need neither.");
  process.exit(1);
}

await seedDemoCatalog();
const app = createApp({
  demo: createDemoHandler(deps),
  // No webhook id, so a delivery here is answered 503 and nothing is applied.
  webhooks: { ...payPalWebhookDepsFromEnv({}), webhookId: null },
  hsts: false,
  proxyHops: 0,
  onDemoRequest: () => {},
  log: (line) => console.error(line),
});
const server = createServer((req, res) => {
  void app(req, res);
});
await new Promise<void>((done) => server.listen(PORT, done));

// ── The story, run the way a visitor's clicks run it ────────────────

const session = deps.sessions.create(new Date());
let firstTrace: string | null = null;
let fixtureTrace: string | null = null;

if (!FRONT_ONLY) {
  // Step 2 of the page, before PayPal is connected, as a visitor meets it.
  for (const beat of ["injection", "fixture"] as const) {
    await runBeat(session, beat, deps);
    const r = session.beats.get(beat);
    console.log(`step ${beat}: ${r?.state ?? "missing"} ${r?.reasonCode ?? ""}`.trimEnd());
  }

  const saved = tokenFile !== null && existsSync(tokenFile) ? readToken(tokenFile) : null;
  if (saved !== null) {
    deps.savedMethods.put(session.id, saved, session.expiresAt);
    session.connected = true;
  } else {
    const approveUrl = await startConnect(session, deps);
    if (approveUrl === null) throw new Error(`PayPal didn't start a connection: ${session.notice ?? "no reason given"}`);
    console.log(`\nOpen this link, log in as the PayPal sandbox buyer and approve:\n\n  ${approveUrl}\n`);
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    await prompt.question("When PayPal has sent you back, press Enter here. ");
    prompt.close();
    await finishConnect(session, null, deps);
    const token = deps.savedMethods.get(session.id, new Date());
    if (!session.connected || token === null) throw new Error(`PayPal isn't connected: ${session.notice ?? "no reason given"}`);
    if (tokenFile !== null) writeFileSync(tokenFile, JSON.stringify({ payment_token: token }), { mode: 0o600 });
  }

  for (const [beat, approve] of [
    ["first", true],
    ["second", false],
    ["large", true],
    ["concurrency", false],
    ["revoke", false],
    ["after_revoke", false],
  ] as const) {
    await runBeat(session, beat, deps);
    if (approve) await decideApproval(session, beat, "approve", deps);
    const r = session.beats.get(beat);
    console.log(`step ${beat}: ${r?.state ?? "missing"} ${r?.reasonCode ?? ""} ${r?.orderStatus ?? ""}`.trimEnd());
    // A story whose first purchase failed isn't the product; don't overwrite good screenshots with it.
    if (beat === "first" && r?.state !== "done") {
      console.error("The first purchase didn't go through, so no screenshots were taken. If the saved token is stale, delete its file and connect again.");
      server.close();
      await prisma.$disconnect();
      process.exit(1);
    }
  }
  firstTrace = session.beats.get("first")?.traceId ?? null;
  fixtureTrace = session.beats.get("fixture")?.traceId ?? null;
}

// ── Headless Chrome over the DevTools protocol ──────────────────────

const profile = mkdtempSync(join(tmpdir(), "praman-shots-"));
const debugPort = PORT + 1000;
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${debugPort.toString()}`, `--user-data-dir=${profile}`, "--no-first-run", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let socketUrl: string | null = null;
for (let i = 0; i < 75 && socketUrl === null; i++) {
  try {
    const targets: unknown = await (await fetch(`http://127.0.0.1:${debugPort.toString()}/json/list`)).json();
    if (Array.isArray(targets)) {
      for (const t of targets) if (typeof t === "object" && t !== null && "type" in t && t.type === "page" && "webSocketDebuggerUrl" in t && typeof t.webSocketDebuggerUrl === "string") socketUrl = t.webSocketDebuggerUrl;
    }
  } catch {
    // Chrome isn't listening yet.
  }
  if (socketUrl === null) await pause(200);
}
if (socketUrl === null) throw new Error(`${CHROME} didn't start a page to drive`);

const ws = new WebSocket(socketUrl);
await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
let nextId = 0;
const waiting = new Map<number, (result: Record<string, unknown>) => void>();
ws.addEventListener("message", (event) => {
  const msg: unknown = JSON.parse(String(event.data));
  if (typeof msg !== "object" || msg === null || !("id" in msg) || typeof msg.id !== "number") return;
  const done = waiting.get(msg.id);
  waiting.delete(msg.id);
  const result = "result" in msg && typeof msg.result === "object" && msg.result !== null ? { ...msg.result } : {};
  done?.(result);
});
const send = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<Record<string, unknown>>((resolve) => {
    nextId += 1;
    waiting.set(nextId, resolve);
    ws.send(JSON.stringify({ id: nextId, method, params }));
  });

await send("Page.enable");
await send("Network.enable");

const WIDTHS = { desktop: 1280, mobile: 390 } as const;

async function shoot(name: string, path: string, width: keyof typeof WIDTHS, opts: { readonly cookie?: boolean; readonly settleMs?: number } = {}): Promise<void> {
  const w = WIDTHS[width];
  const mobile = width === "mobile";
  await send("Network.clearBrowserCookies");
  if (opts.cookie === true) await send("Network.setCookie", { name: "praman_demo", value: session.id, domain: "localhost", path: "/demo" });
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: mobile ? 844 : 900, deviceScaleFactor: mobile ? 2 : 1, mobile });
  await send("Page.navigate", { url: `${BASE}${path}` });
  await pause(opts.settleMs ?? 1500);
  const measured = await send("Runtime.evaluate", { expression: "JSON.stringify([document.documentElement.scrollHeight, document.documentElement.scrollWidth, document.documentElement.clientWidth])", returnByValue: true });
  const inner = measured["result"];
  const value = typeof inner === "object" && inner !== null && "value" in inner && typeof inner.value === "string" ? inner.value : "[900,0,0]";
  const dims: unknown = JSON.parse(value);
  const [height, scrollWidth, clientWidth] = Array.isArray(dims) ? dims.map(Number) : [900, 0, 0];
  if ((scrollWidth ?? 0) > (clientWidth ?? 0)) console.error(`${name}: scrolls sideways (${String(scrollWidth)} > ${String(clientWidth)})`);
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: Math.min(height ?? 900, 16000), scale: 1 } });
  const data = shot["data"];
  if (typeof data !== "string") throw new Error(`no screenshot for ${name}`);
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
  console.log(`wrote docs/screenshots/${name}.png`);
}

try {
  for (const width of ["desktop", "mobile"] as const) {
    await shoot(`landing-${width}`, "/", width);
    await shoot(`demo-start-${width}`, "/demo", width);
    if (FRONT_ONLY) continue;
    await shoot(`demo-story-${width}`, "/demo", width, { cookie: true });
    await shoot(`demo-console-${width}`, "/demo/console", width, { cookie: true, settleMs: 4000 });
    if (firstTrace !== null) await shoot(`demo-no-buyer-trace-${width}`, `/r/${encodeURIComponent(firstTrace)}`, width);
    if (fixtureTrace !== null) await shoot(`demo-refused-trace-${width}`, `/r/${encodeURIComponent(fixtureTrace)}`, width);
  }
} finally {
  ws.close();
  const exited = new Promise((done) => chrome.once("exit", done));
  chrome.kill();
  await exited;
  server.close();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  // The saved token stays at PayPal for the next run. It is only dropped from memory here.
  deps.savedMethods.take(session.id);
  await prisma.$disconnect();
}
