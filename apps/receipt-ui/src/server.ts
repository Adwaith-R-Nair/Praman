import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// Same reason as scripts/verify-ledger.ts — dotenv must load before any
// dynamic import reaches @praman/db.
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const { renderTracePage } = await import("./pages/trace.js");
const { renderIndexPage } = await import("./pages/index.js");
const { verifyTrace } = await import("./verify.js");
const { buildBundleStandalone } = await import("@praman/dispute");
const { handlePayPalWebhook, payPalWebhookDepsFromEnv, readRawBody } = await import("./webhooks.js");

const { createDemoHandler, sweepExpiredSessions } = await import("./demo/routes.js");
const { demoDepsFromEnv } = await import("./demo/wiring.js");
const { seedDemoCatalog } = await import("./demo/seed.js");

const payPalWebhooks = payPalWebhookDepsFromEnv(process.env);

const PORT = Number(process.env["RECEIPT_UI_PORT"] ?? 4100);

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

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const traceMatch = /^\/r\/([^/]+)\/?$/.exec(url.pathname);
    const verifyMatch = /^\/verify\/([^/]+)\/?$/.exec(url.pathname);
    const disputeMatch = /^\/dispute\/([^/]+)\/?$/.exec(url.pathname);

    try {
      if (url.pathname === "/demo" || url.pathname.startsWith("/demo/")) {
        if (demo === null) {
          res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("The demo isn't configured on this server.");
          return;
        }
        await demo(req, res);
        return;
      }

      if (url.pathname === "/webhooks/paypal") {
        if (req.method !== "POST") {
          res.writeHead(405, { Allow: "POST", "Content-Type": "text/plain; charset=utf-8" });
          res.end("Method not allowed");
          return;
        }
        const rawBody = await readRawBody(req);
        const reply = rawBody === null ? { status: 413, body: "too large" } : await handlePayPalWebhook(rawBody, req.headers, payPalWebhooks);
        res.writeHead(reply.status, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(reply.body);
        return;
      }

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
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
          return;
        }
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${traceId}.json"`,
        });
        res.end(JSON.stringify(bundle, null, 2));
        return;
      }

      if (url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(await renderIndexPage());
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    } catch (err) {
      console.error(err);
      // The error is in the server log. A visitor gets no stack trace or message.
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Internal error");
    }
  })();
});

server.listen(PORT, () => {
  console.log(`receipt-ui listening on http://localhost:${PORT.toString()}`);
});
