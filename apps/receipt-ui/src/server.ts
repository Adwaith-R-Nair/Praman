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

const PORT = Number(process.env["RECEIPT_UI_PORT"] ?? 4100);

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const traceMatch = /^\/r\/([^/]+)\/?$/.exec(url.pathname);
    const verifyMatch = /^\/verify\/([^/]+)\/?$/.exec(url.pathname);
    const disputeMatch = /^\/dispute\/([^/]+)\/?$/.exec(url.pathname);

    try {
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
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Internal error: ${String(err)}`);
    }
  })();
});

server.listen(PORT, () => {
  console.log(`receipt-ui listening on http://localhost:${PORT.toString()}`);
});
