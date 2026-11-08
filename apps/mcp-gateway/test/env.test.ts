import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateKeypair, signMandate } from "@praman/mandate";
import { gatewayFromEnv } from "../src/env.js";
import { gatewayMandate } from "../src/terms.js";

const keys = generateKeypair();
const dir = mkdtempSync(join(tmpdir(), "praman-mcp-"));
const good = join(dir, "good.json");
const tampered = join(dir, "tampered.json");
const signed = signMandate(gatewayMandate(new Date(), 1), keys.privateKeyPem, "k1");
writeFileSync(good, JSON.stringify(signed));
writeFileSync(tampered, JSON.stringify({ ...signed, document: { ...signed.document, limits: { ...signed.document.limits, max_total_minor: "99999999" } } }));

const base = { MANDATE_PUBLIC_KEY: Buffer.from(keys.publicKeyPem).toString("base64"), PRAMAN_MCP_MANDATE: good };

describe("gatewayFromEnv", () => {
  it("starts in simulation with a mandate that verifies, and says so", () => {
    const r = gatewayFromEnv({ ...base, PRAMAN_MCP_SIMULATE: "1" });
    expect(r.ok && r.value.mode).toBe("simulated");
    expect(r.ok && r.value.deps.merchants).toEqual(["DEMO_SHOP"]);
  });

  it("uses the PayPal sandbox when its keys are set", () => {
    const r = gatewayFromEnv({ ...base, PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret" });
    expect(r.ok && r.value.mode).toBe("paypal-sandbox");
    expect(r.ok && r.value.deps.route("paypal")?.rail).toBe("paypal");
    expect(r.ok && r.value.deps.route("razorpay")).toBe(null);
  });

  it("refuses to start with no rail rather than pretending", () => {
    const r = gatewayFromEnv(base);
    expect(r.ok).toBe(false);
  });

  it("refuses to start with a mandate whose limits were edited after signing", () => {
    const r = gatewayFromEnv({ ...base, PRAMAN_MCP_SIMULATE: "1", PRAMAN_MCP_MANDATE: tampered });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/doesn't verify/);
  });

  it("refuses to start with no mandate file", () => {
    const r = gatewayFromEnv({ ...base, PRAMAN_MCP_SIMULATE: "1", PRAMAN_MCP_MANDATE: join(dir, "missing.json") });
    expect(r.ok).toBe(false);
  });
});

describe("pnpm mcp:approve", () => {
  it("won't approve for a caller with no terminal, such as an agent's shell tool", () => {
    const script = fileURLToPath(new URL("../src/approve.ts", import.meta.url));
    const tsx = fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url));
    let stderr = "";
    let code = 0;
    try {
      execFileSync(tsx, [script, "apr_anything", "approve"], { stdio: ["pipe", "pipe", "pipe"], encoding: "utf8" });
    } catch (err) {
      const e = err as { status: number; stderr: string };
      code = e.status;
      stderr = e.stderr;
    }
    expect(code).toBe(1);
    expect(stderr).toMatch(/must be run by a person in a terminal/);
  });
});
