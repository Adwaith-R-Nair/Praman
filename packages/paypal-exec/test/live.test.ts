import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { acceptOutcome } from "@praman/exec-core";
import { minor } from "@praman/shared";
import { PayPalExecutor, PAYPAL_SANDBOX_BASE_URL } from "../src/executor.js";

const clientId = process.env["PAYPAL_CLIENT_ID"];
const clientSecret = process.env["PAYPAL_CLIENT_SECRET"];

/**
 * Real calls to the PayPal sandbox when its keys are in .env, skipped otherwise,
 * as in CI. They create unapproved orders, which can't be voided (D-26) and move no
 * money. Capture after approval isn't here: no sandbox approval has registered yet,
 * so capture is only tested against PayPal's documented shapes.
 */
describe.runIf(clientId && clientSecret)("PayPal sandbox, live", () => {
  const paypal = new PayPalExecutor({ clientId: clientId ?? "", clientSecret: clientSecret ?? "", baseUrl: PAYPAL_SANDBOX_BASE_URL, fetch: globalThis.fetch });
  // A test fixture, unique per run so that each run gets a new order. Real keys are derived from the intent.
  const keyFor = (label: string) => createHash("sha256").update(`praman-live-test|${label}|${Date.now()}`).digest("hex");
  const request = (label: string, cents: bigint) => ({ amount_minor: minor(cents), currency: "USD" as const, idempotency_key: keyFor(label), receipt: keyFor(label).slice(0, 40) });

  it("creates a real sandbox order", { timeout: 30_000 }, async () => {
    const outcome = await paypal.createOrder(request("create", 1250n));
    expect(outcome.status).toBe("created");
    expect(outcome.order_id).not.toBe("");
    expect(outcome.amount_minor).toBe(1250n);
    expect(outcome.currency).toBe("USD");
    expect(outcome.approve_url).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);
  });

  it("finds the same order by repeating the create with the same key", { timeout: 30_000 }, async () => {
    const req = request("repeat", 1999n);
    const created = await paypal.createOrder(req);
    const found = await paypal.findOrder({ receipt: req.receipt, idempotency_key: req.idempotency_key, order_id: null, amount_minor: req.amount_minor, currency: req.currency });
    expect(found?.order_id).toBe(created.order_id);
    expect(found?.status).toBe("created");
  });

  it("reports the original order when a key is reused for another amount", { timeout: 30_000 }, async () => {
    const req = request("reuse", 2000n);
    const first = await paypal.createOrder(req);
    const second = await paypal.createOrder({ ...req, amount_minor: minor(9900n) });
    expect(second.order_id).toBe(first.order_id);
    expect(second.amount_minor).toBe(2000n);
    expect(acceptOutcome(second, { amount_minor: minor(9900n), currency: "USD" })).toMatchObject({ status: "mismatch", failure_code: "RAIL_AMOUNT_MISMATCH", rail_amount_minor: 2000n });
  });

  it("reads an order back by id", { timeout: 30_000 }, async () => {
    const req = request("read", 500n);
    const created = await paypal.createOrder(req);
    const found = await paypal.findOrder({ receipt: req.receipt, idempotency_key: req.idempotency_key, order_id: created.order_id, amount_minor: req.amount_minor, currency: req.currency });
    expect(found).toMatchObject({ order_id: created.order_id, status: "created", amount_minor: 500n, currency: "USD" });
  });

  it("gets a definite not approved from a capture before any buyer approval", { timeout: 30_000 }, async () => {
    const req = request("early-capture", 750n);
    const created = await paypal.createOrder(req);
    const outcome = await paypal.capture({ order_id: created.order_id, amount_minor: req.amount_minor, currency: req.currency, idempotency_key: keyFor("early-capture-key") });
    expect(outcome).toMatchObject({ status: "failed", order_id: created.order_id, payment_id: null });
    expect(outcome.failure_code).toBe("ORDER_NOT_APPROVED");
  });

  it("answers no order for an id PayPal doesn't know", { timeout: 30_000 }, async () => {
    const found = await paypal.findOrder({ receipt: "r", idempotency_key: keyFor("missing"), order_id: "0NOSUCHORDER000000", amount_minor: minor(100n), currency: "USD" });
    expect(found).toBeNull();
  });
});
