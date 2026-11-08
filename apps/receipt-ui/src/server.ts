import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// Same reason as scripts/verify-ledger.ts — dotenv must load before any
// dynamic import reaches @praman/db. On a host with no .env file this loads
// nothing, and the host's own environment is used.
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

// Before anything else: no live credentials, no live base URL, and never the local
// mandate key on a server that signs mandates for strangers. Exits rather than limps.
const { checkStartup } = await import("./startup.js");
const startup = await checkStartup(process.env, globalThis.fetch);
if (!startup.ok) {
  for (const reason of startup.reasons) console.error(`receipt-ui: refusing to start: ${reason}`);
  process.exit(1);
}
for (const note of startup.notes) console.log(`receipt-ui: ${note}`);

const { createApp } = await import("./app.js");
const { payPalWebhookDepsFromEnv } = await import("./webhooks.js");
const { createDemoHandler, releaseAllSessions, sweepExpiredSessions } = await import("./demo/routes.js");
const { demoDepsFromEnv } = await import("./demo/wiring.js");
const { seedDemoCatalog } = await import("./demo/seed.js");
const { DemoActivity, runSweeps, scheduleSweeps } = await import("./sweeps.js");
const { routeByRail } = await import("@praman/exec-core");
const { LiveExecutor } = await import("@praman/razorpay-exec");
type Executor = import("@praman/exec-core").Executor;

const PORT = Number(process.env["RECEIPT_UI_PORT"] ?? process.env["PORT"] ?? 4100);

// The demo story under /demo. Off, with a plain page saying why, unless its own key is set.
const demoWiring = demoDepsFromEnv(process.env, PORT);
const demo = demoWiring.ok ? createDemoHandler(demoWiring.deps) : null;
if (demoWiring.ok) {
  await seedDemoCatalog();
  const deps = demoWiring.deps;
  // Ends expired sessions and gives up their saved PayPal methods. One failure doesn't stop the next run.
  setInterval(() => {
    sweepExpiredSessions(deps).catch((err: unknown) => console.error(`demo: session sweep failed: ${err instanceof Error ? err.name : "unknown error"}`));
  }, 60_000).unref();
} else {
  console.log(`receipt-ui: demo off: ${demoWiring.reason}`);
}

// The reconcile and release sweeps, in this process. They run once now, then every
// minute while the demo has been used in the last 30 minutes, so the database can
// sleep when nobody is here. They ask only the rails this server has keys for; there
// is no simulator here, which would answer "not found" about a real order.
const executors: Executor[] = [];
if (demoWiring.ok && demoWiring.deps.paypal !== null) executors.push(demoWiring.deps.paypal.executor);
const rzpId = process.env["RAZORPAY_KEY_ID"];
const rzpSecret = process.env["RAZORPAY_KEY_SECRET"];
if (rzpId && rzpSecret) executors.push(new LiveExecutor(rzpId, rzpSecret));
const activity = new DemoActivity();
const sweepDeps = { route: routeByRail(executors), now: () => new Date(), log: (line: string) => console.log(line) };
void runSweeps(sweepDeps);
scheduleSweeps({ ...sweepDeps, activity });

const app = createApp({
  demo,
  webhooks: payPalWebhookDepsFromEnv(process.env),
  hsts: (process.env["DEMO_BASE_URL"] ?? "").startsWith("https://"),
  // checkStartup has already refused anything but a small whole number here.
  proxyHops: Number(process.env["TRUST_PROXY"] || "0"),
  onDemoRequest: () => activity.touch(new Date()),
  ...(demoWiring.ok ? { demoOrigin: new URL(demoWiring.deps.baseUrl).origin } : {}),
  log: (line) => console.error(line),
  // The whole-ledger console, only with the demo off and never in production. With
  // the demo on, each visitor has their own console at /demo/console instead.
  operatorConsole: demo === null && process.env["NODE_ENV"] !== "production",
});

// The app answers its own errors. Anything that still escapes it is logged and the one
// request is ended, so a single bad request can never stop the process for everyone.
const server = createServer((req, res) => {
  app(req, res).catch((err: unknown) => {
    console.error(`receipt-ui: request failed outside the app: ${err instanceof Error ? err.name : "unknown error"}`);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end();
  });
});

server.listen(PORT, () => {
  console.log(`receipt-ui listening on http://localhost:${PORT.toString()}`);
  if (demo === null && process.env["NODE_ENV"] !== "production") console.log(`receipt-ui: operator console at http://localhost:${PORT.toString()}/console`);
});

// On SIGTERM or Ctrl-C, stop taking requests, then delete the demo's saved PayPal
// methods at PayPal before exiting, waiting at most five seconds. A crash skips this,
// and those tokens stay at PayPal (D-50).
let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log(`receipt-ui: ${signal}, shutting down`);
  server.close();
  if (demoWiring.ok) await releaseAllSessions(demoWiring.deps, 5_000);
  process.exit(0);
}
const SIGNALS: readonly NodeJS.Signals[] = ["SIGTERM", "SIGINT"];
for (const signal of SIGNALS) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
