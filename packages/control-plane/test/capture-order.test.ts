import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@praman/db";
import { append, deriveState } from "@praman/ledger";
import { generateKeypair } from "@praman/mandate";
import { routeAllTo, routeByRail, SimulatedExecutor, type CaptureRequest, type ExecOutcome, type Executor, type OrderLookup } from "@praman/exec-core";
import { ORDER_NOT_APPROVED as PAYPAL_ORDER_NOT_APPROVED } from "@praman/paypal-exec";
import { minor } from "@praman/shared";
import { captureOrder, captureRecordKey, ORDER_NOT_APPROVED } from "../src/capture-order.js";
import { reconcilePending } from "../src/reconcile.js";
import { RECONCILE_MIN_AGE_MS } from "../src/run-intent.js";
import { buildUsdMandate, CheckoutExecutor, outcomesFor, placeOrder, PRICE, resetCheckoutFixtures, seedPriorHistory, T0 } from "./support/checkout.js";

beforeEach(resetCheckoutFixtures);

afterAll(async () => {
  await prisma.$disconnect();
});

const LATER = new Date(T0.getTime() + 60_000);

async function setup(mandateId: string) {
  await seedPriorHistory(mandateId);
  const { signed, publicKeyPem } = buildUsdMandate(mandateId);
  const executor = new CheckoutExecutor();
  const ctx = { signed, publicKeyPem, mandateId };
  return { executor, ctx, route: routeByRail([executor]) };
}

async function captureDecisions(traceId: string) {
  const rows = await prisma.ledgerEntry.findMany({ where: { traceId, eventType: "capture_decision" }, orderBy: { seq: "asc" } });
  return rows.map((r) => r.payload);
}

describe("captureOrder", () => {
  it("keeps PayPal's not-approved code in step with paypal-exec", () => {
    expect(ORDER_NOT_APPROVED).toBe(PAYPAL_ORDER_NOT_APPROVED);
  });

  it("derives the capture key from the order key, with the attempt number after the first", () => {
    const k = "a".repeat(64);
    expect(captureRecordKey(k)).toBe(captureRecordKey(k, 0));
    expect(captureRecordKey(k)).toMatch(/^[0-9a-f]{64}$/);
    expect(captureRecordKey(k, 1)).not.toBe(captureRecordKey(k));
    expect(captureRecordKey(k, 1)).toBe(captureRecordKey(k, 1));
  });

  it("captures once when called twice, one ledger outcome, budget counted once", async () => {
    const { executor, ctx, route } = await setup("mnd_cap_twice");
    const order = await placeOrder(executor, ctx, "int_cap_twice");
    executor.approve(order.orderId);

    const first = await captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, route, LATER);
    const second = await captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, route, LATER);

    expect(first).toEqual({ kind: "CAPTURED", trace_id: order.traceId, order_id: order.orderId, payment_id: `CAP_${order.orderId}` });
    expect(second).toEqual(first);
    expect(executor.captureCalls).toHaveLength(1);
    expect((await outcomesFor(order.key)).map((p) => p["status"])).toEqual(["created", "captured"]);

    const state = await prisma.$transaction((tx) => deriveState(tx, ctx.mandateId));
    expect(state.spent_minor).toBe(minor(1000n + 1250n));
    expect(state.txn_timestamps).toHaveLength(2);
  });

  it("captures once under two concurrent calls", async () => {
    const { executor, ctx, route } = await setup("mnd_cap_race");
    const order = await placeOrder(executor, ctx, "int_cap_race");
    executor.approve(order.orderId);
    executor.captureDelayMs = 50;

    const results = await Promise.all([
      captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, route, LATER),
      captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, route, LATER),
    ]);

    expect(executor.captureCalls).toHaveLength(1);
    expect(results.map((r) => r.kind).sort()).toEqual(["CAPTURED", "IN_FLIGHT"]);
    expect((await outcomesFor(order.key)).filter((p) => p["status"] === "captured")).toHaveLength(1);
    expect(await prisma.idempotencyRecord.count({ where: { kind: "capture" } })).toBe(1);
  });

  it("writes the order's key and order id on every capture row, never the capture key", async () => {
    const { executor, ctx, route } = await setup("mnd_cap_keys");
    const order = await placeOrder(executor, ctx, "int_cap_keys");
    executor.approve(order.orderId);
    await captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, route, LATER);

    const captureKey = captureRecordKey(order.key);
    const rows = await prisma.ledgerEntry.findMany({ where: { traceId: order.traceId, eventType: { in: ["capture_decision", "api_call", "outcome"] } }, orderBy: { seq: "asc" } });
    const captureRows = rows.slice(-3).map((r) => r.payload as Record<string, unknown>);
    expect(rows.slice(-3).map((r) => r.eventType)).toEqual(["capture_decision", "api_call", "outcome"]);
    for (const p of captureRows) {
      expect(p["idempotency_key"]).toBe(order.key);
      expect(p["order_id"]).toBe(order.orderId);
    }
    expect(captureRows[1]?.["capture_key"]).toBe(captureKey);
    expect(captureRows[2]?.["capture_key"]).toBe(captureKey);
    expect(executor.captureCalls[0]?.idempotency_key).toBe(captureKey);

    const record = await prisma.idempotencyRecord.findUniqueOrThrow({ where: { key: captureKey } });
    expect(record).toMatchObject({ kind: "capture", orderKey: order.key, orderId: order.orderId, status: "succeeded", amountMinor: 1250n });
  });

  it("refuses capture after revocation and moves no money", async () => {
    const { executor, ctx, route } = await setup("mnd_cap_revoked");
    const order = await placeOrder(executor, ctx, "int_cap_revoked");
    executor.approve(order.orderId);
    await prisma.$transaction((tx) =>
      append(tx, { traceId: "trc_revoke", ts: T0, actor: "issuer", eventType: "mandate_revoked", payload: { mandate_id: ctx.mandateId, reason: "test" } }),
    );

    const result = await captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, route, LATER);

    expect(result).toMatchObject({ kind: "REFUSED", reason_code: "MANDATE_REVOKED" });
    expect(executor.captureCalls).toHaveLength(0);
    expect(executor.order(order.orderId).captured).toBe(false);
    expect(await prisma.idempotencyRecord.count({ where: { kind: "capture" } })).toBe(0);
    expect(await captureDecisions(order.traceId)).toEqual([
      expect.objectContaining({ kind: "DENY", reason_code: "MANDATE_REVOKED", idempotency_key: order.key, order_id: order.orderId }),
    ]);
  });

  it("refuses capture after expiry and moves no money", async () => {
    const { executor, ctx, route } = await setup("mnd_cap_expired");
    const order = await placeOrder(executor, ctx, "int_cap_expired");
    executor.approve(order.orderId);

    const result = await captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, route, new Date("2027-01-01T00:00:00.000Z"));

    expect(result).toMatchObject({ kind: "REFUSED", reason_code: "MANDATE_EXPIRED" });
    expect(executor.captureCalls).toHaveLength(0);
  });

  it("refuses when the rail's amount differs from the hold", async () => {
    const { executor, ctx, route } = await setup("mnd_cap_requote");
    const order = await placeOrder(executor, ctx, "int_cap_requote");
    executor.approve(order.orderId);
    executor.quoteAmount = minor(999n);

    const result = await captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, route, LATER);

    expect(result).toMatchObject({ kind: "REFUSED", reason_code: "AMOUNT_CHANGED_SINCE_APPROVAL" });
    expect(executor.captureCalls).toHaveLength(0);
  });

  it("refuses an order recorded as a mismatch, even when the rail now quotes the authorised amount", async () => {
    const { executor, ctx, route } = await setup("mnd_cap_mismatch");
    executor.createAmount = minor(1n);
    const order = await placeOrder(executor, ctx, "int_cap_mismatch");
    expect((await outcomesFor(order.key))[0]?.["status"]).toBe("mismatch");
    executor.approve(order.orderId);
    executor.quoteAmount = minor(PRICE);

    const result = await captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, route, LATER);

    expect(result).toMatchObject({ kind: "REFUSED", reason_code: "AMOUNT_CHANGED_SINCE_APPROVAL" });
    expect(executor.captureCalls).toHaveLength(0);
  });

  it("a capture refusal is a capture_decision and does not count toward the denial cap", async () => {
    const { executor, ctx, route } = await setup("mnd_cap_cap");
    const order = await placeOrder(executor, ctx, "int_cap_cap");
    await captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, route, new Date("2027-01-01T00:00:00.000Z"));

    const decisions = await prisma.ledgerEntry.count({ where: { traceId: order.traceId, eventType: "decision", payload: { path: ["kind"], equals: "DENY" } } });
    expect(decisions).toBe(0);
    const state = await prisma.$transaction((tx) => deriveState(tx, ctx.mandateId));
    expect(state.denied_attempts).toHaveLength(0);
  });

  it("a definite failure moves no money, keeps the hold, and a retry with a fresh derived key captures", async () => {
    const { executor, ctx, route } = await setup("mnd_cap_retry");
    const order = await placeOrder(executor, ctx, "int_cap_retry");

    // The buyer hasn't approved yet: PayPal's definite ORDER_NOT_APPROVED.
    const early = await captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, route, LATER);
    expect(early).toEqual({ kind: "FAILED", trace_id: order.traceId, order_id: order.orderId, failure_code: "ORDER_NOT_APPROVED" });
    // Taken at its word: the order is not read back after the capture.
    expect(executor.findCalls).toHaveLength(1);
    const held = await prisma.$transaction((tx) => deriveState(tx, ctx.mandateId));
    expect(held.spent_minor).toBe(minor(1000n + 1250n));
    expect(await prisma.idempotencyRecord.findUnique({ where: { key: captureRecordKey(order.key) } })).toMatchObject({ status: "failed" });

    executor.approve(order.orderId);
    const retry = await captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, route, LATER);

    expect(retry).toMatchObject({ kind: "CAPTURED", order_id: order.orderId });
    expect(executor.captureCalls.map((c) => c.idempotency_key)).toEqual([captureRecordKey(order.key, 0), captureRecordKey(order.key, 1)]);
    const after = await prisma.$transaction((tx) => deriveState(tx, ctx.mandateId));
    expect(after.spent_minor).toBe(minor(1000n + 1250n));
    expect((await outcomesFor(order.key)).map((p) => p["status"])).toEqual(["created", "failed", "captured"]);
  });

  it("reads the order back after any other refusal, and records a capture that happened", async () => {
    const { executor, ctx, route } = await setup("mnd_cap_readback");
    const order = await placeOrder(executor, ctx, "int_cap_readback");
    executor.approve(order.orderId);
    executor.captureAnswer = "refuse_but_captured";
    executor.refuseCode = "A_CODE_PAYPAL_ADDS_LATER";

    const result = await captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, route, LATER);

    expect(result).toMatchObject({ kind: "CAPTURED", order_id: order.orderId });
    expect((await outcomesFor(order.key)).map((p) => p["status"])).toEqual(["created", "captured"]);
  });

  it("calls a refusal failed only after the read-back shows no capture", async () => {
    const { executor, ctx, route } = await setup("mnd_cap_refused");
    const order = await placeOrder(executor, ctx, "int_cap_refused");
    executor.approve(order.orderId);
    executor.captureAnswer = "refuse";
    executor.refuseCode = "INSTRUMENT_DECLINED";

    const result = await captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, route, LATER);

    expect(result).toMatchObject({ kind: "FAILED", failure_code: "INSTRUMENT_DECLINED" });
    expect(executor.findCalls.map((c) => c.order_id)).toEqual([order.orderId, order.orderId]);
  });

  it("leaves the capture record pending when the call's outcome is unknown", async () => {
    const { executor, ctx, route } = await setup("mnd_cap_unknown");
    const order = await placeOrder(executor, ctx, "int_cap_unknown");
    executor.approve(order.orderId);
    executor.captureAnswer = "throw";

    const result = await captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, route, LATER);
    expect(result.kind).toBe("IN_FLIGHT");
    expect(await prisma.idempotencyRecord.findUnique({ where: { key: captureRecordKey(order.key) } })).toMatchObject({ status: "pending" });

    // A second try waits for the reconciler rather than calling again.
    const again = await captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, route, LATER);
    expect(again.kind).toBe("IN_FLIGHT");
    expect(executor.captureCalls).toHaveLength(1);
  });

  it("captures nothing and writes nothing when the order can't be read at the rail", async () => {
    const { executor, ctx, route } = await setup("mnd_cap_noread");
    const order = await placeOrder(executor, ctx, "int_cap_noread");
    executor.findThrows = true;
    const before = await prisma.ledgerEntry.count();

    const result = await captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, route, LATER);

    expect(result.kind).toBe("IN_FLIGHT");
    expect(executor.captureCalls).toHaveLength(0);
    expect(await prisma.ledgerEntry.count()).toBe(before);
  });

  it("finds nothing for an unknown trace, or for another mandate's order", async () => {
    const { executor, ctx, route } = await setup("mnd_cap_owner");
    const order = await placeOrder(executor, ctx, "int_cap_owner");
    const other = buildUsdMandate("mnd_cap_stranger");

    expect((await captureOrder("trc_nope", ctx.signed, ctx.publicKeyPem, route, LATER)).kind).toBe("NOT_FOUND");
    expect((await captureOrder(order.traceId, other.signed, other.publicKeyPem, route, LATER)).kind).toBe("NOT_FOUND");
    expect(executor.captureCalls).toHaveLength(0);
  });

  it("refuses a bad signature as a claim, and calls nothing", async () => {
    const { executor, ctx, route } = await setup("mnd_cap_badsig");
    const order = await placeOrder(executor, ctx, "int_cap_badsig");
    const wrongKey = generateKeypair().publicKeyPem;

    const result = await captureOrder(order.traceId, ctx.signed, wrongKey, route, LATER);

    expect(result).toMatchObject({ kind: "REFUSED", reason_code: "MANDATE_SIGNATURE_INVALID" });
    expect(executor.captureCalls).toHaveLength(0);
    expect(await captureDecisions(order.traceId)).toEqual([expect.objectContaining({ claimed_mandate_id: ctx.mandateId, kind: "DENY" })]);
  });

  it("refuses a rail with no executor here, and never asks another rail", async () => {
    const { executor, ctx } = await setup("mnd_cap_norail");
    const order = await placeOrder(executor, ctx, "int_cap_norail");
    const sim = new SimulatedExecutor();

    const result = await captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, routeAllTo(sim), LATER);

    expect(result).toMatchObject({ kind: "REFUSED", reason_code: "MERCHANT_OUT_OF_SCOPE" });
  });

  it("a late T2 writes nothing when another writer already resolved its record", async () => {
    const { executor, ctx } = await setup("mnd_cap_late_t2");
    const order = await placeOrder(executor, ctx, "int_cap_late_t2");
    executor.approve(order.orderId);
    const held = new HeldCapture(executor);

    const pending = captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, routeByRail([held]), LATER);
    await held.untilHeld();

    // While this call is held between T1 and T2, the sweep resolves its record.
    const sweepTime = new Date(Date.now() + RECONCILE_MIN_AGE_MS + 60_000);
    expect(await reconcilePending(routeByRail([executor]), sweepTime)).toBe(1);
    held.open();

    expect(await pending).toEqual({ kind: "CAPTURED", trace_id: order.traceId, order_id: order.orderId, payment_id: `CAP_${order.orderId}` });
    expect((await outcomesFor(order.key)).map((p) => p["status"])).toEqual(["created", "captured"]);
    expect(await prisma.idempotencyRecord.findUniqueOrThrow({ where: { key: captureRecordKey(order.key) } })).toMatchObject({ status: "succeeded" });
  });
});

/** Holds the first capture call until open(), so a test can act between T1 and T2. Reads pass straight through. */
class HeldCapture implements Executor {
  readonly #inner: Executor;
  #open: () => void = () => {};
  readonly #gate = new Promise<void>((resolve) => {
    this.#open = resolve;
  });
  #held = false;

  constructor(inner: Executor) {
    this.#inner = inner;
  }

  get rail(): Executor["rail"] {
    return this.#inner.rail;
  }

  async untilHeld(): Promise<void> {
    while (!this.#held) await new Promise((resolve) => setTimeout(resolve, 5));
  }

  open(): void {
    this.#open();
  }

  createOrder(req: Parameters<Executor["createOrder"]>[0]): Promise<ExecOutcome> {
    return this.#inner.createOrder(req);
  }

  findOrder(lookup: OrderLookup): Promise<ExecOutcome | null> {
    return this.#inner.findOrder(lookup);
  }

  async capture(req: CaptureRequest): Promise<ExecOutcome> {
    this.#held = true;
    await this.#gate;
    return this.#inner.capture(req);
  }
}
