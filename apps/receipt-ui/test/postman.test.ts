import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// docs/postman is how a judge calls the server without a browser. These keep it
// covering every public route and keep it free of anything secret.

interface Request {
  readonly method: string;
  readonly url: { readonly raw: string };
  readonly header: readonly { readonly key: string; readonly value: string }[];
}

interface Item {
  readonly name: string;
  readonly item?: readonly Item[];
  readonly request?: Request;
}

function load(name: string): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../../../docs/postman/${name}`, import.meta.url)), "utf8"));
}

function requests(items: readonly Item[]): Request[] {
  return items.flatMap((i) => (i.item !== undefined ? requests(i.item) : i.request !== undefined ? [i.request] : []));
}

const collection = load("praman.postman_collection.json") as { readonly item: readonly Item[] };
const all = requests(collection.item);
const routes = new Set(all.map((r) => `${r.method} ${r.url.raw.replace("{{base_url}}", "").split("?")[0] ?? ""}`));

const STEPS = ["first", "second", "large", "injection", "fixture", "concurrency", "revoke", "after_revoke"];
const PURCHASES = ["first", "second", "large"];

const EXPECTED = [
  "GET /healthz",
  "GET /",
  "GET /traces",
  "GET /r/{{trace_id}}",
  "GET /verify/{{trace_id}}",
  "GET /dispute/{{trace_id}}",
  "GET /console",
  "GET /console/data",
  "POST /webhooks/paypal",
  "GET /demo",
  "POST /demo/start",
  "POST /demo/end",
  "POST /demo/connect",
  "GET /demo/connect/return",
  "GET /demo/connect/cancel",
  "GET /demo/checkout/return",
  "GET /demo/checkout/cancel",
  "GET /demo/console",
  "GET /demo/console/data",
  "GET /demo/recorded",
  "GET /demo/recorded-run.png",
  "GET /demo/client.js",
  "GET /demo/demo.css",
  ...STEPS.map((s) => `POST /demo/step/${s}`),
  ...PURCHASES.flatMap((p) => [`POST /demo/approve/${p}`, `POST /demo/reject/${p}`, `POST /demo/capture/${p}`, `POST /demo/refund/${p}`, `GET /demo/r/${p}`]),
];

describe("the Postman collection", () => {
  it.each(EXPECTED)("has a request for %s", (route) => {
    expect(routes.has(route)).toBe(true);
  });

  it("sends no credentials", () => {
    for (const r of all) {
      for (const h of r.header) expect(h.key.toLowerCase()).not.toMatch(/^(authorization|cookie|x-api-key)$/);
    }
    expect(JSON.stringify(collection)).not.toMatch(/client_secret|api[_-]?key|Bearer /i);
  });

  it.each(["praman-local.postman_environment.json", "praman-hosted.postman_environment.json"])("%s holds only a base URL and ids", (file) => {
    const env = load(file) as { readonly values: readonly { readonly key: string }[] };
    expect(env.values.map((v) => v.key).sort()).toEqual(["approval_token_id", "base_url", "trace_id"]);
  });

  it("has no em dash in its text", () => {
    expect(JSON.stringify(collection)).not.toContain("—");
  });
});
