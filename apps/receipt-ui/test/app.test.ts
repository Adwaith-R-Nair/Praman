import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Every database call fails, the way it would with the database asleep or gone, and the
// error carries text no visitor should see. /healthz must answer anyway.
const dbCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("@praman/db", () => {
  const fail = (): never => {
    dbCalls.count += 1;
    throw new Error("connect ECONNREFUSED postgresql://praman:hunter2@db.internal:5432/praman");
  };
  const model = new Proxy({}, { get: () => fail });
  const prisma = new Proxy({}, { get: (_t, prop) => (typeof prop === "string" && prop.startsWith("$") ? fail : model) });
  return { prisma, loadCatalog: fail, loadMerchantConfig: fail };
});

const { createApp, CONTENT_SECURITY_POLICY } = await import("../src/app.js");

let server: Server;
let base: string;
const logs: string[] = [];

beforeAll(async () => {
  const app = createApp({
    demo: null,
    webhooks: { webhookId: null, verify: async () => false, apply: async () => ({ kind: "ignored", reason: "test" }) as never, now: () => new Date() },
    hsts: true,
    onDemoRequest: () => {},
    log: (line) => logs.push(line),
  });
  server = createServer((req, res) => {
    void app(req, res);
  });
  server.listen(0);
  await once(server, "listening");
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(() => {
  server.close();
});

describe("the public server", () => {
  it("/healthz answers without touching the database", async () => {
    const before = dbCalls.count;
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(dbCalls.count).toBe(before);
  });

  it("the catch-all 500 shows a plain message and never the error's text", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain("ECONNREFUSED");
    expect(body).not.toContain("hunter2");
    expect(body).not.toMatch(/at \S+ \(/);
    expect(body).toContain("Something went wrong");
    expect(dbCalls.count).toBeGreaterThan(0);
    expect(logs.join("\n")).toContain("ECONNREFUSED");
  });

  it("every response carries a strict content security policy and the other security headers", async () => {
    for (const path of ["/healthz", "/", "/assets/style.css", "/assets/trace.js", "/nope", "/demo"]) {
      const res = await fetch(`${base}${path}`);
      await res.text();
      expect(res.headers.get("content-security-policy"), path).toBe(CONTENT_SECURITY_POLICY);
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(res.headers.get("x-frame-options"), path).toBe("DENY");
      expect(res.headers.get("referrer-policy"), path).toBe("same-origin");
      expect(res.headers.get("strict-transport-security"), path).toContain("max-age=");
    }
    expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-inline");
    expect(CONTENT_SECURITY_POLICY).not.toContain("unsafe-eval");
    expect(CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
  });

  it("serves only the listed assets, never a file a path names", async () => {
    for (const path of ["/assets/../server.ts", "/assets/app.ts", "/assets/%2e%2e/app.ts", "/assets/style.css/"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).not.toBe(200);
      expect(await res.text(), path).not.toContain("import");
    }
  });

  it("refuses a method a read-only route doesn't take", async () => {
    const res = await fetch(`${base}/r/trc_x`, { method: "POST" });
    expect(res.status).toBe(405);
  });
});
