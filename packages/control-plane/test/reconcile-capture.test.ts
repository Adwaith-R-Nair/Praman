import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@praman/db";
import { deriveState } from "@praman/ledger";
import { routeByRail } from "@praman/exec-core";
import { minor } from "@praman/shared";
import { captureOrder, captureRecordKey, ORDER_HOLD_TTL_MS } from "../src/capture-order.js";
import { reconcilePending } from "../src/reconcile.js";
import { releaseStaleOrders } from "../src/release-orders.js";
import { RECONCILE_MIN_AGE_MS } from "../src/run-intent.js";
import { buildUsdMandate, CheckoutExecutor, outcomesFor, placeOrder, resetCheckoutFixtures, seedPriorHistory, T0 } from "./support/checkout.js";

beforeEach(async () => {
  await resetCheckoutFixtures();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.$disconnect();
});

/** A capture whose call threw, leaving its record pending, aged past the reconcile gate. */
async function strandedCapture(mandateId: string, answer: "throw" | "throw_but_captured" | "throw_completing", approved = true) {
  await seedPriorHistory(mandateId);
  const { signed, publicKeyPem } = buildUsdMandate(mandateId);
  const executor = new CheckoutExecutor();
  const route = routeByRail([executor]);
  const ctx = { signed, publicKeyPem, mandateId };
  const order = await placeOrder(executor, ctx, `int_${mandateId}`);
  if (approved) executor.approve(order.orderId);
  executor.captureAnswer = answer;
  expect((await captureOrder(order.traceId, signed, publicKeyPem, route, T0)).kind).toBe("IN_FLIGHT");
  executor.captureAnswer = "capture";
  return { executor, route, ctx, order, captureKey: captureRecordKey(order.key) };
}

async function age(key: string): Promise<void> {
  await prisma.$executeRaw`UPDATE idempotency_record SET created_at = ${new Date(Date.now() - RECONCILE_MIN_AGE_MS - 1000)} WHERE key = ${key}`;
}

describe("reconcilePending on a capture record", () => {
  it("leaves a capture with an unknown outcome pending, then reconciles it by order id", async () => {
    const { executor, route, ctx, order, captureKey } = await strandedCapture("mnd_rc_landed", "throw_but_captured");
    await age(captureKey);

    expect(await reconcilePending(route, new Date())).toBe(1);

    // Asked about the order by its id. The create was never repeated.
    expect(executor.findCalls.at(-1)?.order_id).toBe(order.orderId);
    const rows = await outcomesFor(order.key);
    expect(rows.map((p) => p["status"])).toEqual(["created", "captured"]);
    expect(rows[1]).toMatchObject({ idempotency_key: order.key, order_id: order.orderId, capture_key: captureKey, reconciled: true, mandate_id: ctx.mandateId });
    expect(await prisma.idempotencyRecord.findUniqueOrThrow({ where: { key: captureKey } })).toMatchObject({ status: "succeeded" });
    expect((await prisma.$transaction((tx) => deriveState(tx, ctx.mandateId))).spent_minor).toBe(minor(1000n + 1250n));

    // A buyer retrying now gets the capture that happened, with no second call.
    const again = await captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, route, T0);
    expect(again).toMatchObject({ kind: "CAPTURED", order_id: order.orderId });
    expect(executor.captureCalls).toHaveLength(1);
  });

  it("completes a capture that never reached the rail by sending it again under the same key", async () => {
    const { executor, route, ctx, order, captureKey } = await strandedCapture("mnd_rc_lost", "throw");
    await age(captureKey);

    expect(await reconcilePending(route, new Date())).toBe(1);

    // The same derived key, so PayPal-Request-Id makes the repeat the same capture, not a second one.
    expect(executor.captureCalls.map((c) => c.idempotency_key)).toEqual([captureKey, captureKey]);
    const rows = await outcomesFor(order.key);
    expect(rows.map((p) => p["status"])).toEqual(["created", "captured"]);
    expect(rows[1]).toMatchObject({ idempotency_key: order.key, order_id: order.orderId, capture_key: captureKey, reconciled: true });
    expect(await prisma.idempotencyRecord.findUniqueOrThrow({ where: { key: captureKey } })).toMatchObject({ status: "succeeded" });
    expect((await prisma.$transaction((tx) => deriveState(tx, ctx.mandateId))).spent_minor).toBe(minor(1000n + 1250n));
  });

  it("records a capture of an order the buyer never approved as failed, keeps the hold, and a retry can capture", async () => {
    const { executor, route, ctx, order, captureKey } = await strandedCapture("mnd_rc_unapproved", "throw", false);
    await age(captureKey);

    expect(await reconcilePending(route, new Date())).toBe(1);

    const rows = await outcomesFor(order.key);
    expect(rows.map((p) => p["status"])).toEqual(["created", "failed"]);
    expect(rows[1]).toMatchObject({ order_id: order.orderId, capture_key: captureKey, failure_code: "ORDER_NOT_APPROVED" });
    expect(await prisma.idempotencyRecord.findUniqueOrThrow({ where: { key: captureKey } })).toMatchObject({ status: "failed" });
    expect((await prisma.$transaction((tx) => deriveState(tx, ctx.mandateId))).spent_minor).toBe(minor(1000n + 1250n));

    executor.approve(order.orderId);
    const retry = await captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, route, T0);
    expect(retry).toMatchObject({ kind: "CAPTURED" });
    expect(executor.captureCalls.at(-1)?.idempotency_key).toBe(captureRecordKey(order.key, 1));
  });

  it("leaves a capture PayPal is still completing pending, so the release sweep keeps the hold", async () => {
    const { executor, route, ctx, order, captureKey } = await strandedCapture("mnd_rc_completing", "throw_completing");
    await age(captureKey);

    // The order still reads as approved and not captured. That is not proof no money moved.
    expect(await reconcilePending(route, new Date())).toBe(0);
    expect(await prisma.idempotencyRecord.findUniqueOrThrow({ where: { key: captureKey } })).toMatchObject({ status: "pending" });
    expect(await releaseStaleOrders(route, new Date(T0.getTime() + ORDER_HOLD_TTL_MS + 3 * 60 * 1000))).toBe(0);
    expect((await outcomesFor(order.key)).map((p) => p["status"])).toEqual(["created"]);

    // PayPal finishes. The next run records the capture, and the budget counts it.
    executor.finishCapture(order.orderId);
    expect(await reconcilePending(route, new Date())).toBe(1);
    expect((await outcomesFor(order.key)).map((p) => p["status"])).toEqual(["created", "captured"]);
    expect((await prisma.$transaction((tx) => deriveState(tx, ctx.mandateId))).spent_minor).toBe(minor(1000n + 1250n));
  });

  it("does not touch a capture record younger than the reconcile age", async () => {
    const { route, captureKey } = await strandedCapture("mnd_rc_young", "throw_but_captured");

    expect(await reconcilePending(route, new Date())).toBe(0);
    expect(await prisma.idempotencyRecord.findUniqueOrThrow({ where: { key: captureKey } })).toMatchObject({ status: "pending" });
  });

  it("leaves a capture pending when the rail can't be asked", async () => {
    const { executor, route, captureKey } = await strandedCapture("mnd_rc_noask", "throw_but_captured");
    await age(captureKey);
    executor.findThrows = true;

    expect(await reconcilePending(route, new Date())).toBe(0);
    expect(await prisma.idempotencyRecord.findUniqueOrThrow({ where: { key: captureKey } })).toMatchObject({ status: "pending" });
  });
});
