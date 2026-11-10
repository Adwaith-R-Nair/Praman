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
const { HouseBuyer } = await import("../apps/receipt-ui/src/demo/house.js");
const { MemoryDailyUsage } = await import("../apps/receipt-ui/src/demo/limits.js");
const { seedDemoCatalog } = await import("../apps/receipt-ui/src/demo/seed.js");
const { SavedMethods, SessionStore } = await import("../apps/receipt-ui/src/demo/session.js");
const { payPalWebhookDepsFromEnv } = await import("../apps/receipt-ui/src/webhooks.js");
const { FakePayPal, ScriptedModel } = await import("../apps/receipt-ui/test/stand-ins.js");
const { seedShopFixture } = await import("../apps/receipt-ui/test/shop-fixture.js");

const PORT = Number(process.env["E2E_PORT"] ?? 4190);
const baseUrl = `http://localhost:${PORT.toString()}`;

await seedDemoCatalog();
// The shop (D-93): three products from the committed Channel3 test fixture, standing in for the snapshot.
await seedShopFixture();

const paypal = new FakePayPal(`${baseUrl}/__e2e/paypal/connect`);
const { privateKeyPem, publicKeyPem } = generateKeypair();
const demoDeps = (standIn: InstanceType<typeof FakePayPal>) => ({
  sessions: new SessionStore({ privateKeyPem, publicKeyPem, keyId: "e2e_demo_k1" }),
  savedMethods: new SavedMethods(),
  publicKeyPem,
  paypal: { executor: standIn, vault: standIn },
  provider: new ScriptedModel(),
  baseUrl,
  now: () => new Date(),
  log: (line: string) => console.error(line),
});

// The real server reads DEMO_HOUSE_BUYER_TOKEN once at start-up, so a process either has
// the demo's shared sandbox buyer (D-85) or it doesn't. The suite needs both, so there
// are two demos here, each with its own sessions and its own stand-in PayPal: one as a
// server without the secret, and one with a stand-in token. A request header a test sets
// picks the second, for the demo and for /__e2e/paypal. The header exists in this file
// only; the app never reads it.
const HOUSE_HEADER = "x-e2e-house";
const HOUSE_TOKEN = "E2E-HOUSE-TOKEN";
const housePaypal = new FakePayPal(`${baseUrl}/__e2e/paypal/connect`);
const plainDemo = createDemoHandler({ ...demoDeps(paypal), usage: new MemoryDailyUsage({ session: 1000, model_call: 1000 }) });
const houseDemo = createDemoHandler({
  ...demoDeps(housePaypal),
  usage: new MemoryDailyUsage({ session: 1000, model_call: 1000, house_session: 1000 }),
  house: new HouseBuyer(HOUSE_TOKEN),
});

const app = createApp({
  demo: (req, res) => (req.headers[HOUSE_HEADER] === "1" ? houseDemo : plainDemo)(req, res),
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
    const asked = req.headers[HOUSE_HEADER] === "1" ? housePaypal : paypal;
    if (req.method === "POST") asked.approveAll();
    res.writeHead(200, { "Content-Type": "application/json" });
    // house_charges: how many of the charges named the stand-in house token. A count, never the token.
    const houseCharges = asked.charges.filter((charge) => charge.vaultId === HOUSE_TOKEN).length;
    res.end(JSON.stringify({ charges: asked.charges.length, house_charges: houseCharges, checkouts: asked.checkouts.length, refunds: asked.refunds.length, deleted: asked.deleted.length }));
    return;
  }
  void app(req, res);
};

createServer(listener).listen(PORT, () => console.log(`e2e server on ${baseUrl}`));
