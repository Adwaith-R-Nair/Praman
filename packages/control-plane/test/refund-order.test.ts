import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@praman/db";
import { deriveState } from "@praman/ledger";
import { generateKeypair, signMandate, type MandateDocument } from "@praman/mandate";
import { routeByRail, type Executor } from "@praman/exec-core";
import { minor } from "@praman/shared";
import { captureOrder } from "../src/capture-order.js";
import { reconcilePending } from "../src/reconcile.js";
import { refundOrder, refundRecordKey } from "../src/refund-order.js";
import { revokeMandate } from "../src/revoke-mandate.js";
import { RECONCILE_MIN_AGE_MS, runIntent } from "../src/run-intent.js";
import { buildUsdMandate, CheckoutExecutor, intentFor, MERCHANT, placeOrder, PRICE, resetCheckoutFixtures, seedPriorHistory, T0 } from "./support/checkout.js";

// Refunds (D-66, D-67). The rail is the stand-in from support/checkout.ts, which answers
// a refund the way the sandbox did on 2026-11-08 (D-68): the same key gives the same
// refund, and a new key on a capture already refunded in full gives CAPTURE_FULLY_REFUNDED.

beforeEach(resetCheckoutFixtures);
afterAll(async () => {
  await prisma.$disconnect();
});

const LATER = new Date(T0.getTime() + 60_000);
const AFTER = new Date(T0.getTime() + 120_000);

async function setup(mandateId: string) {
  await seedPriorHistory(mandateId);
  const { signed, publicKeyPem } = buildUsdMandate(mandateId);
  const executor = new CheckoutExecutor();
  const ctx = { signed, publicKeyPem, mandateId };
  return { executor, ctx, route: routeByRail([executor]) };
}

/** A checkout order the buyer approved and Praman captured. */
async function capturedCheckout(mandateId: string, intentId = `int_${mandateId}`) {
  const s = await setup(mandateId);
  const order = await placeOrder(s.executor, s.ctx, intentId);
  s.executor.approve(order.orderId);
  const captured = await captureOrder(order.traceId, s.ctx.signed, s.ctx.publicKeyPem, s.route, LATER);
  expect(captured.kind).toBe("CAPTURED");
  return { ...s, order, paymentId: `CAP_${order.orderId}` };
}

async function rows(traceId: string, eventType: "refund_requested" | "refund_outcome") {
  const found = await prisma.ledgerEntry.findMany({ where: { traceId, eventType }, orderBy: { seq: "asc" } });
  return found.map((r) => ({ actor: r.actor, payload: r.payload as Record<string, unknown> }));
}

async function refundRecords(orderKey: string) {
  return prisma.idempotencyRecord.findMany({ where: { kind: "refund", orderKey }, orderBy: { createdAt: "asc" } });
}

/** Ages a refund record past the reconciler's minimum, as a stuck one would be. */
async function age(key: string): Promise<void> {
  await prisma.$executeRaw`UPDATE idempotency_record SET created_at = ${new Date(Date.now() - RECONCILE_MIN_AGE_MS - 1000)} WHERE key = ${key}`;
}

const asOperator = (traceId: string) => ({ traceId, mandateIds: null, requestedBy: "operator" as const });

describe("refundOrder", () => {
  it("derives the refund key from the order key and the capture, with the attempt number after the first", () => {
    const k = "a".repeat(64);
    expect(refundRecordKey(k, "CAP1")).toBe(refundRecordKey(k, "CAP1", 0));
    expect(refundRecordKey(k, "CAP1")).toMatch(/^[0-9a-f]{64}$/);
    expect(refundRecordKey(k, "CAP2")).not.toBe(refundRecordKey(k, "CAP1"));
    expect(refundRecordKey(k, "CAP1", 1)).not.toBe(refundRecordKey(k, "CAP1"));
  });

  it("refunds a captured checkout order in full, once, and records who asked", async () => {
    const { executor, route, order, paymentId, ctx } = await capturedCheckout("mnd_ref_checkout");

    const result = await refundOrder(asOperator(order.traceId), route, AFTER);

    expect(result).toEqual({ kind: "REFUNDED", trace_id: order.traceId, order_id: order.orderId, payment_id: paymentId, refund_id: "REF0001", amount_minor: PRICE, currency: "USD" });
    expect(executor.refundCalls).toEqual([{ payment_id: paymentId, amount_minor: PRICE, currency: "USD", idempotency_key: refundRecordKey(order.key, paymentId) }]);

    const requested = await rows(order.traceId, "refund_requested");
    expect(requested).toHaveLength(1);
    expect(requested[0]?.actor).toBe("operator");
    expect(requested[0]?.payload).toMatchObject({
      mandate_id: ctx.mandateId,
      merchant_id: MERCHANT,
      idempotency_key: order.key,
      order_id: order.orderId,
      payment_id: paymentId,
      refund_key: refundRecordKey(order.key, paymentId),
      operation: "captures.refund",
      status: "attempted",
      amount_minor: "1250",
      currency: "USD",
      requested_by: "operator",
    });
    const outcomes = await rows(order.traceId, "refund_outcome");
    expect(outcomes.map((r) => r.payload)).toEqual([
      expect.objectContaining({ status: "refunded", refund_id: "REF0001", payment_id: paymentId, amount_minor: "1250", currency: "USD", idempotency_key: order.key, order_id: order.orderId }),
    ]);
    expect((await refundRecords(order.key)).map((r) => [r.status, r.orderId, r.rail])).toEqual([["succeeded", order.orderId, "paypal"]]);
  });

  it("refunds a payment taken from a saved method with no buyer present", async () => {
    const { executor, ctx, route } = await setup("mnd_ref_saved");
    executor.captureOnCreate = true;
    const run = await runIntent(intentFor(ctx.mandateId, "int_ref_saved"), ctx.signed, ctx.publicKeyPem, route, T0, "test-model");
    expect(run.kind === "DECIDED" && run.order_status).toBe("captured");

    const result = await refundOrder(asOperator(run.trace_id), route, AFTER);
    expect(result).toMatchObject({ kind: "REFUNDED", refund_id: "REF0001", amount_minor: PRICE });
  });

  it("gives back no budget and no velocity, so state is the same before and after", async () => {
    const { route, order, ctx } = await capturedCheckout("mnd_ref_state");
    const before = await deriveState(prisma, ctx.mandateId);
    await refundOrder(asOperator(order.traceId), route, AFTER);
    expect(await deriveState(prisma, ctx.mandateId)).toEqual(before);
  });

  it("answers a second request from the ledger, with no second call", async () => {
    const { executor, route, order } = await capturedCheckout("mnd_ref_twice");
    const first = await refundOrder(asOperator(order.traceId), route, AFTER);
    const second = await refundOrder({ ...asOperator(order.traceId), requestedBy: "demo_visitor" }, route, AFTER);

    expect(second).toEqual(first);
    expect(executor.refundCalls).toHaveLength(1);
    expect(await rows(order.traceId, "refund_requested")).toHaveLength(1);
    expect(await rows(order.traceId, "refund_outcome")).toHaveLength(1);
  });

  it("makes one refund call when two requests arrive at once", async () => {
    const { executor, route, order } = await capturedCheckout("mnd_ref_race");
    executor.refundDelayMs = 50;
    const results = await Promise.all([refundOrder(asOperator(order.traceId), route, AFTER), refundOrder(asOperator(order.traceId), route, AFTER)]);

    expect(executor.refundCalls).toHaveLength(1);
    expect(results.map((r) => r.kind).sort()).toEqual(["IN_FLIGHT", "REFUNDED"]);
    expect(await rows(order.traceId, "refund_outcome")).toHaveLength(1);
  });

  it("refuses an order nobody has paid for yet, and writes nothing", async () => {
    const { executor, ctx, route } = await setup("mnd_ref_created");
    const order = await placeOrder(executor, ctx, "int_ref_created");

    const result = await refundOrder(asOperator(order.traceId), route, AFTER);
    expect(result).toMatchObject({ kind: "CANNOT_REFUND", why: "not_captured" });
    expect(executor.refundCalls).toHaveLength(0);
    expect(await rows(order.traceId, "refund_requested")).toHaveLength(0);
    expect(await refundRecords(order.key)).toHaveLength(0);
  });

  it("refuses a trace with no order, and a trace that isn't one of the given mandates'", async () => {
    const { executor, route, order } = await capturedCheckout("mnd_ref_scope");

    expect(await refundOrder(asOperator("trc_nothing_here"), route, AFTER)).toMatchObject({ kind: "CANNOT_REFUND", why: "not_found" });
    expect(await refundOrder({ traceId: order.traceId, mandateIds: ["mnd_someone_else"], requestedBy: "demo_visitor" }, route, AFTER)).toMatchObject({ kind: "CANNOT_REFUND", why: "not_found" });
    expect(executor.refundCalls).toHaveLength(0);
    expect(await rows(order.traceId, "refund_requested")).toHaveLength(0);
  });

  it("refuses an order the rail reported as other money, which needs a person", async () => {
    const { executor, ctx, route } = await setup("mnd_ref_mismatch");
    executor.captureOnCreate = true;
    executor.createAmount = minor(999n);
    const run = await runIntent(intentFor(ctx.mandateId, "int_ref_mismatch"), ctx.signed, ctx.publicKeyPem, route, T0, "test-model");
    expect(run.kind === "DECIDED" && run.order_status).toBe("mismatch");

    expect(await refundOrder(asOperator(run.trace_id), route, AFTER)).toMatchObject({ kind: "CANNOT_REFUND", why: "mismatch" });
    expect(executor.refundCalls).toHaveLength(0);
  });

  it("refuses on a rail that can't refund, and writes nothing", async () => {
    const { executor, route, order } = await capturedCheckout("mnd_ref_norail");
    const noRefund: Executor = { rail: "paypal", createOrder: (r) => executor.createOrder(r), findOrder: (l) => executor.findOrder(l), capture: (r) => executor.capture(r) };

    expect(await refundOrder(asOperator(order.traceId), routeByRail([noRefund]), AFTER)).toMatchObject({ kind: "CANNOT_REFUND", why: "rail_cannot_refund" });
    expect(await refundOrder(asOperator(order.traceId), routeByRail([]), AFTER)).toMatchObject({ kind: "CANNOT_REFUND", why: "rail_cannot_refund" });
    expect(executor.refundCalls).toHaveLength(0);
    expect(await rows(order.traceId, "refund_requested")).toHaveLength(0);
    expect(await refundRecords(order.key)).toHaveLength(0);
    expect(route("paypal")).toBe(executor);
  });

  it("leaves an unanswered refund pending, and the reconciler sends the same key again", async () => {
    const { executor, route, order, paymentId } = await capturedCheckout("mnd_ref_lost");
    executor.refundAnswer = "throw_but_refunded";

    expect(await refundOrder(asOperator(order.traceId), route, AFTER)).toMatchObject({ kind: "IN_FLIGHT" });
    const [record] = await refundRecords(order.key);
    expect(record?.status).toBe("pending");
    expect(await rows(order.traceId, "refund_outcome")).toHaveLength(0);

    // A person asking again while it is unresolved gets told so, and nothing is sent.
    expect(await refundOrder(asOperator(order.traceId), route, AFTER)).toMatchObject({ kind: "IN_FLIGHT" });
    expect(executor.refundCalls).toHaveLength(1);

    await age(record?.key ?? "");
    expect(await reconcilePending(route, new Date())).toBe(1);

    expect(executor.refundCalls.map((c) => c.idempotency_key)).toEqual([refundRecordKey(order.key, paymentId), refundRecordKey(order.key, paymentId)]);
    expect(executor.refundsMade).toBe(1);
    const outcomes = await rows(order.traceId, "refund_outcome");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.actor).toBe("reconciler");
    expect(outcomes[0]?.payload).toMatchObject({ status: "refunded", refund_id: "REF0001", reconciled: true, refund_key: record?.key });
    expect((await refundRecords(order.key))[0]?.status).toBe("succeeded");
    expect(await refundOrder(asOperator(order.traceId), route, AFTER)).toMatchObject({ kind: "REFUNDED", refund_id: "REF0001" });
  });

  it("records a definite refusal, and a retry goes out under a new derived key", async () => {
    const { executor, route, order, paymentId } = await capturedCheckout("mnd_ref_refused");
    executor.refundAnswer = "refuse";

    expect(await refundOrder(asOperator(order.traceId), route, AFTER)).toEqual({ kind: "FAILED", trace_id: order.traceId, order_id: order.orderId, failure_code: "REFUND_NOT_ALLOWED" });
    expect((await rows(order.traceId, "refund_outcome")).map((r) => r.payload["status"])).toEqual(["failed"]);
    expect((await refundRecords(order.key)).map((r) => r.status)).toEqual(["failed"]);

    executor.refundAnswer = "refund";
    expect(await refundOrder(asOperator(order.traceId), route, AFTER)).toMatchObject({ kind: "REFUNDED" });
    expect(executor.refundCalls.map((c) => c.idempotency_key)).toEqual([refundRecordKey(order.key, paymentId), refundRecordKey(order.key, paymentId, 1)]);
  });

  it("records a pending refund once, frees nothing, and the reconciler records it when it completes", async () => {
    const { executor, route, order, ctx } = await capturedCheckout("mnd_ref_pending");
    const before = await deriveState(prisma, ctx.mandateId);
    executor.refundAnswer = "pending";

    expect(await refundOrder(asOperator(order.traceId), route, AFTER)).toMatchObject({ kind: "PENDING", refund_id: "REF0001" });
    expect(await refundOrder(asOperator(order.traceId), route, AFTER)).toMatchObject({ kind: "PENDING", refund_id: "REF0001" });
    expect(executor.refundCalls).toHaveLength(1);
    expect(await deriveState(prisma, ctx.mandateId)).toEqual(before);

    const [record] = await refundRecords(order.key);
    expect(record?.status).toBe("pending");
    await age(record?.key ?? "");

    // Still pending at PayPal: the reconciler asks again and writes nothing new.
    expect(await reconcilePending(route, new Date())).toBe(0);
    expect((await rows(order.traceId, "refund_outcome")).map((r) => r.payload["status"])).toEqual(["pending"]);

    executor.finishRefunds();
    expect(await reconcilePending(route, new Date())).toBe(1);
    expect((await rows(order.traceId, "refund_outcome")).map((r) => r.payload["status"])).toEqual(["pending", "refunded"]);
    expect((await refundRecords(order.key))[0]?.status).toBe("succeeded");
    expect(await deriveState(prisma, ctx.mandateId)).toEqual(before);
    expect(await refundOrder(asOperator(order.traceId), route, AFTER)).toMatchObject({ kind: "REFUNDED", refund_id: "REF0001" });
  });

  it("records a refund of other money as a mismatch, and never sends it again", async () => {
    const { executor, route, order } = await capturedCheckout("mnd_ref_other_money");
    executor.refundAmount = minor(1n);

    expect(await refundOrder(asOperator(order.traceId), route, AFTER)).toMatchObject({ kind: "MISMATCH" });
    expect((await rows(order.traceId, "refund_outcome"))[0]?.payload).toMatchObject({ status: "mismatch", amount_minor: "1250", rail_amount_minor: "1", failure_code: "RAIL_AMOUNT_MISMATCH" });
    expect(await refundOrder(asOperator(order.traceId), route, AFTER)).toMatchObject({ kind: "MISMATCH" });
    expect(executor.refundCalls).toHaveLength(1);
  });

  it("still refunds after the mandate is revoked: money going back is not the agent spending", async () => {
    const { route, order, ctx } = await capturedCheckout("mnd_ref_revoked");
    await revokeMandate({ mandateId: ctx.mandateId, reason: "test", traceId: "trc_ref_revoke", now: LATER });

    expect(await refundOrder(asOperator(order.traceId), route, AFTER)).toMatchObject({ kind: "REFUNDED" });
  });
});

describe("buy, refund, buy (D-67)", () => {
  it("a refund gives no budget back, so the agent can't spend past the mandate by looping", async () => {
    const mandateId = "mnd_ref_loop";
    await seedPriorHistory(mandateId); // 1000 spent at this merchant already
    const { privateKeyPem, publicKeyPem } = generateKeypair();
    const doc: MandateDocument = {
      mandate_id: mandateId,
      version: 2,
      issuer_id: "usr_t",
      subject_id: "agt_t",
      scope: { merchant_ids: [MERCHANT], categories: ["food"], currency: "USD" },
      // Room for exactly one more 1250 purchase after the 1000 already spent.
      limits: { max_per_txn_minor: "80000", max_total_minor: "2500", max_txns_per_window: 50, window_seconds: 3600, max_denials_per_window: 50 },
      step_up: { threshold_minor: "50000" },
      validity: { not_before: "2026-08-28T00:00:00.000Z", not_after: "2026-12-31T00:00:00.000Z" },
      nonce: "loop",
    };
    const signed = signMandate(doc, privateKeyPem, "k1");
    const executor = new CheckoutExecutor();
    executor.captureOnCreate = true;
    const route = routeByRail([executor]);

    const buy = await runIntent(intentFor(mandateId, "int_loop_1"), signed, publicKeyPem, route, T0, "test-model");
    expect(buy.kind === "DECIDED" && buy.order_status).toBe("captured");
    expect(await refundOrder(asOperator(buy.trace_id), route, AFTER)).toMatchObject({ kind: "REFUNDED" });

    const again = await runIntent(intentFor(mandateId, "int_loop_2"), signed, publicKeyPem, route, AFTER, "test-model");
    expect(again.kind === "DECIDED" && again.internal_reason_code).toBe("MANDATE_BUDGET_EXHAUSTED");
    expect((await deriveState(prisma, mandateId)).spent_minor).toBe(2250n);
  });
});
