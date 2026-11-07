import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@praman/db";
import { append, deriveState } from "@praman/ledger";
import { receiptFor, routeByRail, type SettlementEvent } from "@praman/exec-core";
import { minor, type Minor } from "@praman/shared";
import { captureOrder, captureRecordKey, ORDER_HOLD_TTL_MS } from "../src/capture-order.js";
import { reconcilePending } from "../src/reconcile.js";
import { releaseStaleOrders } from "../src/release-orders.js";
import { MANDATE_LOCK_NS, RECONCILE_MIN_AGE_MS } from "../src/run-intent.js";
import { applySettlement } from "../src/settlement.js";
import { buildUsdMandate, CheckoutExecutor, outcomesFor, placeOrder, resetCheckoutFixtures, seedPriorHistory, T0 } from "./support/checkout.js";
import { HeldCapture } from "./support/held-capture.js";

beforeEach(async () => {
  await resetCheckoutFixtures();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.$disconnect();
});

const LATER = new Date(T0.getTime() + 60_000);
const WEBHOOK_TIME = new Date(T0.getTime() + 120_000);

async function setup(mandateId: string) {
  await seedPriorHistory(mandateId);
  const { signed, publicKeyPem } = buildUsdMandate(mandateId);
  const executor = new CheckoutExecutor();
  const ctx = { signed, publicKeyPem, mandateId };
  const order = await placeOrder(executor, ctx, `int_${mandateId}`);
  executor.approve(order.orderId);
  return { executor, ctx, order, route: routeByRail([executor]) };
}

/** What a verified PayPal delivery parses to. The ids are synthetic, like the fixtures in paypal-exec. */
function event(orderId: string, over: Partial<SettlementEvent> = {}): SettlementEvent {
  return {
    rail: "paypal",
    event_id: "WH-SYNTHETIC-0001",
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    status: "captured",
    order_id: orderId,
    payment_id: `CAP_${orderId}`,
    amount_minor: minor(1250n),
    currency: "USD",
    invoice_id: null,
    ...over,
  };
}

async function settlements(): Promise<Record<string, unknown>[]> {
  const rows = await prisma.ledgerEntry.findMany({ where: { eventType: "settlement" }, orderBy: { seq: "asc" } });
  return rows.map((r) => {
    const p = r.payload;
    if (p === null || typeof p !== "object" || Array.isArray(p)) throw new Error("payload is not an object");
    return p;
  });
}

async function spent(mandateId: string): Promise<Minor> {
  return (await prisma.$transaction((tx) => deriveState(tx, mandateId))).spent_minor;
}

/** A capture whose call threw, so its record is pending and nobody knows the outcome. */
async function strandedCapture(mandateId: string) {
  const s = await setup(mandateId);
  s.executor.captureAnswer = "throw_but_captured";
  expect((await captureOrder(s.order.traceId, s.ctx.signed, s.ctx.publicKeyPem, s.route, LATER)).kind).toBe("IN_FLIGHT");
  s.executor.captureAnswer = "capture";
  return { ...s, captureKey: captureRecordKey(s.order.key) };
}

describe("applySettlement", () => {
  it("appends one settlement for capture completed", async () => {
    const { ctx, order, route } = await setup("mnd_set_once");
    expect((await captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, route, LATER)).kind).toBe("CAPTURED");

    expect(await applySettlement(event(order.orderId), WEBHOOK_TIME)).toBe("applied");

    expect(await settlements()).toEqual([
      expect.objectContaining({
        mandate_id: ctx.mandateId,
        idempotency_key: order.key,
        order_id: order.orderId,
        rail: "paypal",
        event_id: "WH-SYNTHETIC-0001",
        event_type: "PAYMENT.CAPTURE.COMPLETED",
        status: "captured",
        payment_id: `CAP_${order.orderId}`,
        amount_minor: "1250",
        currency: "USD",
      }),
    ]);
    const row = await prisma.ledgerEntry.findFirstOrThrow({ where: { eventType: "settlement" } });
    expect(row.traceId).toBe(order.traceId);
    // T2 already recorded the capture, so the webhook only confirms it.
    expect((await outcomesFor(order.key)).map((p) => p["status"])).toEqual(["created", "captured"]);
    expect(await spent(ctx.mandateId)).toBe(minor(1000n + 1250n));
  });

  it("a duplicate delivery appends nothing", async () => {
    const { ctx, order, route } = await setup("mnd_set_dup");
    await captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, route, LATER);

    expect(await applySettlement(event(order.orderId), WEBHOOK_TIME)).toBe("applied");
    const before = await prisma.ledgerEntry.count();
    expect(await applySettlement(event(order.orderId), WEBHOOK_TIME)).toBe("duplicate");
    // The same capture reported again under another event id is the same news.
    expect(await applySettlement(event(order.orderId, { event_id: "WH-SYNTHETIC-0002" }), WEBHOOK_TIME)).toBe("duplicate");

    expect(await prisma.ledgerEntry.count()).toBe(before);
    expect(await settlements()).toHaveLength(1);
  });

  it("deliveries at once append one settlement", async () => {
    const { ctx, order, route } = await setup("mnd_set_race");
    await captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, route, LATER);

    const results = await Promise.all(Array.from({ length: 8 }, () => applySettlement(event(order.orderId), WEBHOOK_TIME)));

    expect(results.filter((r) => r === "applied")).toHaveLength(1);
    expect(results.filter((r) => r === "duplicate")).toHaveLength(7);
    expect(await settlements()).toHaveLength(1);
  });

  it("waits for the mandate lock, so a delivery being written meanwhile is seen as a duplicate", async () => {
    const { ctx, order, route } = await setup("mnd_set_lock");
    await captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, route, LATER);

    // Stands in for the same event being applied by another request: it holds the
    // mandate's lock, and while holding it writes the settlement.
    let letGo: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    let lockTaken: () => void = () => {};
    const taken = new Promise<void>((resolve) => {
      lockTaken = resolve;
    });
    const other = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MANDATE_LOCK_NS}, hashtext(${ctx.mandateId}))`;
        lockTaken();
        await held;
        await append(tx, {
          traceId: order.traceId,
          ts: WEBHOOK_TIME,
          actor: "webhook",
          eventType: "settlement",
          payload: { mandate_id: ctx.mandateId, idempotency_key: order.key, order_id: order.orderId, rail: "paypal", event_id: "WH-SYNTHETIC-0001", status: "captured", payment_id: `CAP_${order.orderId}` },
        });
      },
      { timeout: 10_000 },
    );
    await taken;

    const delivery = applySettlement(event(order.orderId), WEBHOOK_TIME);
    // Time for a delivery that ignores the lock to have written its own row.
    await new Promise((resolve) => setTimeout(resolve, 300));
    letGo();
    await other;

    expect(await delivery).toBe("duplicate");
    expect(await settlements()).toHaveLength(1);
  });

  it("a webhook before T2 ends in the correct state after T2", async () => {
    const { executor, ctx, order } = await setup("mnd_set_early");
    const held = new HeldCapture(executor);
    const pending = captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, routeByRail([held]), LATER);
    await held.untilHeld();

    // PayPal's webhook lands while Praman's own capture call is still out.
    expect(await applySettlement(event(order.orderId), WEBHOOK_TIME)).toBe("applied");
    held.open();

    expect(await pending).toEqual({ kind: "CAPTURED", trace_id: order.traceId, order_id: order.orderId, payment_id: `CAP_${order.orderId}` });
    const rows = await outcomesFor(order.key);
    expect(rows.map((p) => p["status"])).toEqual(["created", "captured"]);
    expect(rows[1]).toMatchObject({ capture_key: captureRecordKey(order.key), settlement_event_id: "WH-SYNTHETIC-0001" });
    expect(await settlements()).toHaveLength(1);
    expect(await prisma.idempotencyRecord.findUniqueOrThrow({ where: { key: captureRecordKey(order.key) } })).toMatchObject({ status: "succeeded" });
    expect(await spent(ctx.mandateId)).toBe(minor(1000n + 1250n));
  });

  it("a webhook naming a pending record resolves it", async () => {
    const { ctx, order, route, captureKey } = await strandedCapture("mnd_set_pending");

    expect(await applySettlement(event(order.orderId), WEBHOOK_TIME)).toBe("applied");

    const rows = await outcomesFor(order.key);
    expect(rows.map((p) => p["status"])).toEqual(["created", "captured"]);
    expect(rows[1]).toMatchObject({ idempotency_key: order.key, order_id: order.orderId, capture_key: captureKey, payment_id: `CAP_${order.orderId}`, mandate_id: ctx.mandateId });
    const actor = await prisma.ledgerEntry.findFirstOrThrow({ where: { eventType: "outcome" }, orderBy: { seq: "desc" }, select: { actor: true } });
    expect(actor.actor).toBe("webhook");
    expect(await prisma.idempotencyRecord.findUniqueOrThrow({ where: { key: captureKey } })).toMatchObject({ status: "succeeded" });

    // The sweep, still the backstop, finds nothing left to do.
    expect(await reconcilePending(route, new Date(Date.now() + RECONCILE_MIN_AGE_MS + 60_000))).toBe(0);
    expect((await captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, route, LATER)).kind).toBe("CAPTURED");
  });

  it("a declined capture leaves a pending record for its own call or the sweep, and the order keeps its hold", async () => {
    const { executor, ctx, order, route } = await setup("mnd_set_declined");
    executor.captureAnswer = "throw";
    expect((await captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, route, LATER)).kind).toBe("IN_FLIGHT");
    const captureKey = captureRecordKey(order.key);

    const declined = event(order.orderId, { event_id: "WH-SYNTHETIC-DECLINED", event_type: "PAYMENT.CAPTURE.DECLINED", status: "declined" });
    expect(await applySettlement(declined, WEBHOOK_TIME)).toBe("applied");

    // A decline names no capture attempt, so it can't close this one (D-46). The settlement row records the news.
    expect(await settlements()).toEqual([expect.objectContaining({ status: "declined", event_id: "WH-SYNTHETIC-DECLINED" })]);
    expect((await outcomesFor(order.key)).map((p) => p["status"])).toEqual(["created"]);
    expect(await prisma.idempotencyRecord.findUniqueOrThrow({ where: { key: captureKey } })).toMatchObject({ status: "pending" });
    expect(await spent(ctx.mandateId)).toBe(minor(1000n + 1250n));

    // The sweep sends the attempt again under its own key, and PayPal answers for that attempt.
    executor.captureAnswer = "refuse";
    executor.refuseCode = "INSTRUMENT_DECLINED";
    expect(await reconcilePending(route, new Date(Date.now() + RECONCILE_MIN_AGE_MS + 60_000))).toBe(1);

    const rows = await outcomesFor(order.key);
    expect(rows.map((p) => p["status"])).toEqual(["created", "failed"]);
    expect(rows[1]).toMatchObject({ failure_code: "INSTRUMENT_DECLINED", capture_key: captureKey });
    expect(await prisma.idempotencyRecord.findUniqueOrThrow({ where: { key: captureKey } })).toMatchObject({ status: "failed" });
    expect(await spent(ctx.mandateId)).toBe(minor(1000n + 1250n));
  });

  it("a late decline from an earlier attempt doesn't close a retry that then captures", async () => {
    const { executor, ctx, order } = await setup("mnd_set_old_decline");
    executor.captureAnswer = "refuse";
    executor.refuseCode = "INSTRUMENT_DECLINED";
    expect((await captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, routeByRail([executor]), LATER)).kind).toBe("FAILED");

    // D-40 allows a retry. It is held between T1 and T2.
    executor.captureAnswer = "capture";
    const held = new HeldCapture(executor);
    const retry = captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, routeByRail([held]), LATER);
    await held.untilHeld();

    // PayPal redelivers the first attempt's decline, say after an earlier 503.
    const old = event(order.orderId, { event_id: "WH-OLD-DECLINE", event_type: "PAYMENT.CAPTURE.DECLINED", status: "declined", payment_id: "CAPOLD1" });
    expect(await applySettlement(old, WEBHOOK_TIME)).toBe("applied");
    held.open();

    expect(await retry).toMatchObject({ kind: "CAPTURED", order_id: order.orderId });
    expect(executor.order(order.orderId).captured).toBe(true);
    expect((await outcomesFor(order.key)).map((p) => p["status"])).toEqual(["created", "failed", "captured"]);
    expect(await prisma.idempotencyRecord.findUniqueOrThrow({ where: { key: captureRecordKey(order.key, 1) } })).toMatchObject({ status: "succeeded" });
    expect(await spent(ctx.mandateId)).toBe(minor(1000n + 1250n));
  });

  it("a capture PayPal reports on a released order is recorded, and counts against the budget again", async () => {
    const { ctx, order, route } = await setup("mnd_set_released");
    await releaseStaleOrders(route, new Date(T0.getTime() + ORDER_HOLD_TTL_MS + 1000));
    expect(await spent(ctx.mandateId)).toBe(minor(1000n));

    expect(await applySettlement(event(order.orderId), WEBHOOK_TIME)).toBe("applied");

    expect((await outcomesFor(order.key)).map((p) => p["status"])).toEqual(["created", "released", "captured"]);
    expect(await spent(ctx.mandateId)).toBe(minor(1000n + 1250n));
  });

  it("a capture for other money is recorded as a mismatch, not a capture", async () => {
    const { ctx, order } = await strandedCapture("mnd_set_mismatch");

    expect(await applySettlement(event(order.orderId, { amount_minor: minor(9900n) }), WEBHOOK_TIME)).toBe("applied");

    const rows = await outcomesFor(order.key);
    expect(rows.map((p) => p["status"])).toEqual(["created", "mismatch"]);
    expect(rows[1]).toMatchObject({ amount_minor: "1250", rail_amount_minor: "9900", rail_status: "captured" });
    expect(await spent(ctx.mandateId)).toBe(minor(1000n + 9900n));
  });

  it("an event for an unknown order is logged and appends nothing", async () => {
    await setup("mnd_set_unknown");
    const before = await prisma.ledgerEntry.count();

    expect(await applySettlement(event("NOSUCHORDER01"), WEBHOOK_TIME)).toBe("unmatched");

    expect(await prisma.ledgerEntry.count()).toBe(before);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("NOSUCHORDER01"));
  });

  it("an event on another rail, or with another order's invoice id, is unmatched", async () => {
    const { order } = await setup("mnd_set_wrong");
    const before = await prisma.ledgerEntry.count();

    expect(await applySettlement(event(order.orderId, { rail: "razorpay" }), WEBHOOK_TIME)).toBe("unmatched");
    expect(await applySettlement(event(order.orderId, { invoice_id: "not-this-orders-receipt" }), WEBHOOK_TIME)).toBe("unmatched");
    expect(await prisma.ledgerEntry.count()).toBe(before);

    // The receipt Praman set as invoice id matches.
    expect(await applySettlement(event(order.orderId, { invoice_id: receiptFor(order.key) }), WEBHOOK_TIME)).toBe("applied");
  });
});
