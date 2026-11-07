import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// Same reason as scripts/verify-ledger.ts — dotenv must load before any
// dynamic import reaches @praman/db. On a host with no .env file this loads
// nothing, and the host's own environment is used.
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

const { createApp } = await import("./app.js");
const { payPalWebhookDepsFromEnv } = await import("./webhooks.js");
const { createDemoHandler, releaseAllSessions, sweepExpiredSessions } = await import("./demo/routes.js");
const { demoDepsFromEnv } = await import("./demo/wiring.js");
const { seedDemoCatalog } = await import("./demo/seed.js");

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

const app = createApp({
  demo,
  webhooks: payPalWebhookDepsFromEnv(process.env),
  hsts: (process.env["DEMO_BASE_URL"] ?? "").startsWith("https://"),
  onDemoRequest: () => {},
  log: (line) => console.error(line),
});

const server = createServer((req, res) => {
  void app(req, res);
});

server.listen(PORT, () => {
  console.log(`receipt-ui listening on http://localhost:${PORT.toString()}`);
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
