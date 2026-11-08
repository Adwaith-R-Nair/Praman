import { execFileSync } from "node:child_process";
import { createServer, type RequestListener } from "node:http";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import pg from "pg";

/**
 * The server behind `pnpm e2e`: the real app, routes and control plane, with only PayPal
 * and the model replaced by the stand-ins the unit tests use. It runs on its own
 * database, praman_e2e, dropped and rebuilt from the migrations each start, so it can
 * run beside `pnpm test` and never touches praman or praman_test.
 *
 * /__e2e/paypal is the one route the app doesn't have: it plays the buyer at PayPal and
 * reports what the stand-in was asked. It exists only in this file. Connecting goes to
 * a page here, not to the sandbox address, so a browser run never leaves this machine.
 */

const REPO = fileURLToPath(new URL("../", import.meta.url));
config({ path: `${REPO}.env`, quiet: true });

const DATABASE = "praman_e2e";
const adminUrl = process.env["TEST_DATABASE_URL"];
if (adminUrl === undefined || adminUrl === "") throw new Error("TEST_DATABASE_URL is not set");
const target = new URL(adminUrl);
target.pathname = `/${DATABASE}`;

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${DATABASE}`);
await admin.end();

const databaseEnv: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: target.href };
delete databaseEnv["DIRECT_DATABASE_URL"];
execFileSync("pnpm", ["--filter", "@praman/db", "exec", "prisma", "migrate", "deploy"], { cwd: REPO, env: databaseEnv, stdio: ["ignore", "ignore", "inherit"] });

// @praman/db reads DATABASE_URL as it is imported, so this has to come first.
process.env["DATABASE_URL"] = target.href;

const { generateKeypair } = await import("@praman/mandate");
const { createApp } = await import("../apps/receipt-ui/src/app.js");
const { createDemoHandler } = await import("../apps/receipt-ui/src/demo/routes.js");
const { MemoryDailyUsage } = await import("../apps/receipt-ui/src/demo/limits.js");
const { seedDemoCatalog } = await import("../apps/receipt-ui/src/demo/seed.js");
const { SavedMethods, SessionStore } = await import("../apps/receipt-ui/src/demo/session.js");
const { payPalWebhookDepsFromEnv } = await import("../apps/receipt-ui/src/webhooks.js");
const { FakePayPal, ScriptedModel } = await import("../apps/receipt-ui/test/stand-ins.js");

const PORT = Number(process.env["E2E_PORT"] ?? 4190);
const baseUrl = `http://localhost:${PORT.toString()}`;

await seedDemoCatalog();

const paypal = new FakePayPal(`${baseUrl}/__e2e/paypal/connect`);
const { privateKeyPem, publicKeyPem } = generateKeypair();
const app = createApp({
  demo: createDemoHandler({
    sessions: new SessionStore({ privateKeyPem, publicKeyPem, keyId: "e2e_demo_k1" }),
    savedMethods: new SavedMethods(),
    publicKeyPem,
    usage: new MemoryDailyUsage({ session: 1000, model_call: 1000 }),
    paypal: { executor: paypal, vault: paypal },
    provider: new ScriptedModel(),
    baseUrl,
    now: () => new Date(),
    log: (line) => console.error(line),
  }),
  webhooks: { ...payPalWebhookDepsFromEnv({}), webhookId: null },
  hsts: false,
  proxyHops: 0,
  onDemoRequest: () => {},
  log: (line) => console.error(line),
});

const listener: RequestListener = (req, res) => {
  const url = new URL(req.url ?? "/", baseUrl);
  if (url.pathname === "/__e2e/paypal/connect") {
    const token = encodeURIComponent(url.searchParams.get("approval_session_id") ?? "");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>Stand-in PayPal</title><a id="approve" href="/demo/connect/return?approval_token_id=${token}&approval_session_id=x">Agree and continue</a>`);
    return;
  }
  if (req.url === "/__e2e/paypal") {
    if (req.method === "POST") paypal.approveAll();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ charges: paypal.charges.length, checkouts: paypal.checkouts.length, refunds: paypal.refunds.length }));
    return;
  }
  void app(req, res);
};

createServer(listener).listen(PORT, () => console.log(`e2e server on ${baseUrl}`));
