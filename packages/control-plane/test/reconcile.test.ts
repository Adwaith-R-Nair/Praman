import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@praman/db";
import { append, deriveState } from "@praman/ledger";
import type { PurchaseIntent } from "@praman/policy";
import { generateKeypair, signMandate, type MandateDocument } from "@praman/mandate";
import { routeAllTo, routeByRail, SimulatedExecutor, type CaptureRequest, type CreateOrderRequest, type ExecOutcome, type Executor, type OrderLookup } from "@praman/exec-core";
import { minor, type Currency, type Rail } from "@praman/shared";
import { runIntent, RECONCILE_MIN_AGE_MS } from "../src/run-intent.js";
import { reconcilePending } from "../src/reconcile.js";
import { resolveApproval } from "../src/resolve-approval.js";

const MERCHANT = "TEST_CRASH_MERCH";
const SKU = "TEST_CRASH_SKU";
const USD_MERCHANT = "TEST_CRASH_USD_MERCH";
const USD_SKU = "TEST_CRASH_USD_SKU";

/**
 * Wraps a real executor so createOrder actually succeeds against it (a real
 * order/receipt gets recorded there) but then throws — simulating "the
 * external call succeeded but something failed before we could record it,"
 * the exact gap D-22's two-phase restructure exists to close.
 */
class CrashAfterSuccessExecutor implements Executor {
  readonly rail = "simulated";
  constructor(private readonly inner: Executor) {}
  async createOrder(req: CreateOrderRequest): Promise<ExecOutcome> {
    await this.inner.createOrder(req);
    throw new Error("SIMULATED_CRASH_AFTER_SUCCESS");
  }
  async findOrder(lookup: OrderLookup) {
    return this.inner.findOrder(lookup);
  }
  async capture(req: CaptureRequest) {
    return this.inner.capture(req);
  }
}

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE ledger_entry, idempotency_record RESTART IDENTITY`;
  await prisma.$executeRaw`DELETE FROM catalog_item WHERE merchant_id = ${MERCHANT}`;
  await prisma.merchant.upsert({
    where: { merchantId: MERCHANT },
    create: { merchantId: MERCHANT, rail: "simulated", currency: "INR" },
    update: { rail: "simulated", currency: "INR" },
  });
  await prisma.catalogItem.create({
    data: { merchantId: MERCHANT, sku: SKU, title: "t", description: "d", category: "food", currency: "INR", priceMinor: 5000n, stockQty: 10 },
  });
  await prisma.$executeRaw`DELETE FROM catalog_item WHERE merchant_id = ${USD_MERCHANT}`;
  await prisma.merchant.upsert({
    where: { merchantId: USD_MERCHANT },
    create: { merchantId: USD_MERCHANT, rail: "simulated", currency: "USD" },
    update: { rail: "simulated", currency: "USD" },
  });
  await prisma.catalogItem.create({
    data: { merchantId: USD_MERCHANT, sku: USD_SKU, title: "t", description: "d", category: "food", currency: "USD", priceMinor: 1250n, stockQty: 10 },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

function buildSignedMandate(mandateId: string, currency: Currency = "INR", merchant = MERCHANT) {
  const { privateKeyPem, publicKeyPem } = generateKeypair();
  const doc: MandateDocument = {
    mandate_id: mandateId,
    version: 2,
    issuer_id: "usr_t",
    subject_id: "agt_t",
    scope: { merchant_ids: [merchant], categories: ["food"], currency },
    limits: { max_per_txn_minor: "80000", max_total_minor: "500000", max_txns_per_window: 5, window_seconds: 3600, max_denials_per_window: 5 },
    step_up: { threshold_minor: "50000" },
    validity: { not_before: "2026-08-28T00:00:00.000Z", not_after: "2026-12-31T00:00:00.000Z" },
    nonce: "n1",
  };
  return { signed: signMandate(doc, privateKeyPem, "k1"), publicKeyPem };
}

async function seedPriorHistory(mandateId: string, merchant = MERCHANT) {
  // evaluate()'s first-merchant step-up would otherwise fire on a fresh
  // mandate's first transaction — this seeds realistic prior history so the
  // test can reach ALLOW.
  await prisma.$transaction((tx) =>
    append(tx, {
      traceId: "trc_seed",
      ts: new Date("2026-08-28T00:00:00.000Z"),
      actor: "praman",
      eventType: "outcome",
      payload: {
        mandate_id: mandateId,
        status: "captured",
        order_id: "order_SEED",
        payment_id: "pay_SEED",
        amount_minor: "1000",
        merchant_id: merchant,
        idempotency_key: "seed",
      },
    }),
  );
}

describe("crash recovery: runIntent survives, reconcile resolves", () => {
  it("a crash after the executor call succeeds leaves a resolvable pending record", async () => {
    const mandateId = "mnd_crash_test_1";
    await seedPriorHistory(mandateId);

    const { signed, publicKeyPem } = buildSignedMandate(mandateId);
    const intent: PurchaseIntent = {
      intent_id: "int_crash_1",
      mandate_id: mandateId,
      merchant_id: MERCHANT,
      line_items: [{ sku: SKU, qty: 1 }],
      requested_at: "2026-08-28T01:00:00.000Z",
      agent_rationale: "test",
    };

    const inner = new SimulatedExecutor();
    const crashy = new CrashAfterSuccessExecutor(inner);
    // Real time, not a fixed historical date: idempotencyRecord.createdAt is
    // stamped by Postgres's own DEFAULT now(), not by this `now` argument —
    // a mismatch here would make the age-gate query below compare against
    // the wrong clock entirely.
    const now = new Date();

    const result = await runIntent(intent, signed, publicKeyPem, routeAllTo(crashy), now, "test-model");
    expect(result.kind).toBe("IN_FLIGHT");

    const traceId = `trc_${intent.intent_id}`;
    const record = await prisma.idempotencyRecord.findFirst({ where: { traceId } });
    expect(record?.status).toBe("pending");
    expect(record?.receipt).not.toBeNull();
    expect(record?.amountMinor).toBe(5000n);

    const ledgerRows = await prisma.ledgerEntry.findMany({ where: { traceId }, orderBy: { seq: "asc" } });
    expect(ledgerRows.map((r) => r.eventType)).toEqual(["intent", "decision", "api_call"]);

    // Backdate createdAt directly rather than waiting RECONCILE_MIN_AGE_MS
    // (60s) for real — deterministic, and doesn't slow the suite down.
    await prisma.$executeRaw`UPDATE idempotency_record SET created_at = ${new Date(now.getTime() - RECONCILE_MIN_AGE_MS - 1000)} WHERE key = ${record?.key}`;

    // Reconcile. Uses the plain inner executor — same order/receipt the
    // crashy wrapper already created there.
    const resolved = await reconcilePending(routeAllTo(inner), now);
    expect(resolved).toBe(1);

    const resolvedRecord = await prisma.idempotencyRecord.findFirst({ where: { traceId } });
    expect(resolvedRecord?.status).toBe("succeeded");

    const outcomeRow = await prisma.ledgerEntry.findFirst({ where: { traceId, eventType: "outcome" } });
    expect(outcomeRow).not.toBeNull();
    const payload = outcomeRow?.payload as Record<string, unknown>;
    // Regression test for the bug found and fixed this session: the
    // reconciled outcome must carry mandate_id/merchant_id, or deriveState
    // (which filters on payload->>'mandate_id') would never see it — a
    // reconciled captured payment would silently never count toward spend.
    expect(payload["mandate_id"]).toBe(mandateId);
    expect(payload["merchant_id"]).toBe(MERCHANT);
    expect(payload["reconciled"]).toBe(true);
    expect(payload["currency"]).toBe("INR");
  });

  it("a repeat of an intent the reconciler found no order for gets a typed answer with no order id", async () => {
    const mandateId = "mnd_crash_not_found";
    await seedPriorHistory(mandateId);
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);
    const intent: PurchaseIntent = {
      intent_id: "int_crash_not_found",
      mandate_id: mandateId,
      merchant_id: MERCHANT,
      line_items: [{ sku: SKU, qty: 1 }],
      requested_at: "2026-08-28T01:00:00.000Z",
      agent_rationale: "test",
    };
    const now = new Date();
    // Times out before any order exists, so the rail has nothing to find later.
    const timesOut = new SimulatedExecutor("timeout");

    expect((await runIntent(intent, signed, publicKeyPem, routeAllTo(timesOut), now, "test-model")).kind).toBe("IN_FLIGHT");
    const traceId = `trc_${intent.intent_id}`;
    await prisma.$executeRaw`UPDATE idempotency_record SET created_at = ${new Date(now.getTime() - RECONCILE_MIN_AGE_MS - 1000)} WHERE trace_id = ${traceId}`;
    expect(await reconcilePending(routeAllTo(timesOut), now)).toBe(1);

    const repeat = await runIntent(intent, signed, publicKeyPem, routeAllTo(timesOut), now, "test-model");

    expect(repeat).toMatchObject({ kind: "DECIDED", order_status: "failed", order_id: null, approve_url: null });
  });

  it("refuses to reconcile a record younger than RECONCILE_MIN_AGE_MS", async () => {
    const mandateId = "mnd_crash_test_2";
    await seedPriorHistory(mandateId);

    const { signed, publicKeyPem } = buildSignedMandate(mandateId);
    const intent: PurchaseIntent = {
      intent_id: "int_crash_2",
      mandate_id: mandateId,
      merchant_id: MERCHANT,
      line_items: [{ sku: SKU, qty: 1 }],
      requested_at: "2026-08-28T01:00:00.000Z",
      agent_rationale: "test",
    };

    const inner = new SimulatedExecutor();
    const crashy = new CrashAfterSuccessExecutor(inner);
    const now = new Date();

    await runIntent(intent, signed, publicKeyPem, routeAllTo(crashy), now, "test-model");

    // createdAt (stamped by Postgres just now) is only milliseconds old —
    // well within the propagation-lag window. Must not resolve yet.
    const resolved = await reconcilePending(routeAllTo(inner), now);
    expect(resolved).toBe(0);

    const traceId = `trc_${intent.intent_id}`;
    const record = await prisma.idempotencyRecord.findFirst({ where: { traceId } });
    expect(record?.status).toBe("pending");
  });

  describe("routing", () => {
    async function crashOnce(mandateId: string, intentId: string, inner: Executor, now: Date) {
      await seedPriorHistory(mandateId);
      const { signed, publicKeyPem } = buildSignedMandate(mandateId);
      const intent: PurchaseIntent = {
        intent_id: intentId,
        mandate_id: mandateId,
        merchant_id: MERCHANT,
        line_items: [{ sku: SKU, qty: 1 }],
        requested_at: "2026-08-28T01:00:00.000Z",
        agent_rationale: "test",
      };
      const crashy: Executor = {
        rail: inner.rail,
        createOrder: async (req) => {
          await inner.createOrder(req);
          throw new Error("SIMULATED_CRASH_AFTER_SUCCESS");
        },
        findOrder: (lookup) => inner.findOrder(lookup),
        capture: (req) => inner.capture(req),
      };
      await runIntent(intent, signed, publicKeyPem, routeAllTo(crashy), now, "test-model");
      const traceId = `trc_${intentId}`;
      await prisma.$executeRaw`UPDATE idempotency_record SET created_at = ${new Date(now.getTime() - RECONCILE_MIN_AGE_MS - 1000)} WHERE trace_id = ${traceId}`;
      return traceId;
    }

    it("asks the rail on the record, with a lookup carrying the key, amount and currency", async () => {
      const now = new Date();
      const inner = new SimulatedExecutor();
      const traceId = await crashOnce("mnd_crash_route", "int_crash_route", inner, now);
      const findOrder = vi.spyOn(inner, "findOrder");
      const asked: Rail[] = [];

      const resolved = await reconcilePending((rail) => {
        asked.push(rail);
        return inner;
      }, now);

      const record = await prisma.idempotencyRecord.findFirst({ where: { traceId } });
      expect(resolved).toBe(1);
      expect(asked).toEqual(["simulated"]);
      expect(findOrder).toHaveBeenCalledWith({ receipt: record?.receipt, idempotency_key: record?.key, order_id: null, amount_minor: 5000n, currency: "INR" });
      const outcome = await prisma.ledgerEntry.findFirst({ where: { traceId, eventType: "outcome" } });
      expect(outcome?.payload).toMatchObject({ rail: "simulated", reconciled: true });
    });

    it("leaves the record pending when no executor exists for its rail", async () => {
      const now = new Date();
      const traceId = await crashOnce("mnd_crash_no_rail", "int_crash_no_rail", new SimulatedExecutor(), now);
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const resolved = await reconcilePending(routeByRail([]), now);

      error.mockRestore();
      expect(resolved).toBe(0);
      expect((await prisma.idempotencyRecord.findFirst({ where: { traceId } }))?.status).toBe("pending");
      expect(await prisma.ledgerEntry.count({ where: { traceId, eventType: "outcome" } })).toBe(0);
    });

    function crashesOnCreate(inner: Executor, rail: Rail = inner.rail): Executor {
      return {
        rail,
        createOrder: async (req) => {
          await inner.createOrder(req);
          throw new Error("SIMULATED_CRASH_AFTER_SUCCESS");
        },
        findOrder: (lookup) => inner.findOrder(lookup),
        capture: (req) => inner.capture(req),
      };
    }

    async function backdate(traceId: string, now: Date) {
      await prisma.$executeRaw`UPDATE idempotency_record SET created_at = ${new Date(now.getTime() - RECONCILE_MIN_AGE_MS - 1000)} WHERE trace_id = ${traceId}`;
    }

    it("reconciles a USD order in USD", async () => {
      const now = new Date();
      const mandateId = "mnd_crash_usd";
      await seedPriorHistory(mandateId, USD_MERCHANT);
      const { signed, publicKeyPem } = buildSignedMandate(mandateId, "USD", USD_MERCHANT);
      const intent: PurchaseIntent = { intent_id: "int_crash_usd", mandate_id: mandateId, merchant_id: USD_MERCHANT, line_items: [{ sku: USD_SKU, qty: 1 }], requested_at: "2026-08-28T01:00:00.000Z", agent_rationale: "test" };
      const inner = new SimulatedExecutor();
      await runIntent(intent, signed, publicKeyPem, routeAllTo(crashesOnCreate(inner)), now, "test-model");
      await backdate("trc_int_crash_usd", now);
      const findOrder = vi.spyOn(inner, "findOrder");

      expect(await reconcilePending(routeAllTo(inner), now)).toBe(1);

      expect(findOrder).toHaveBeenCalledWith(expect.objectContaining({ amount_minor: 1250n, currency: "USD" }));
      const outcome = await prisma.ledgerEntry.findFirst({ where: { traceId: "trc_int_crash_usd", eventType: "outcome" } });
      expect(outcome?.payload).toMatchObject({ status: "captured", amount_minor: "1250", currency: "USD", reconciled: true });
    });

    it("keeps two records on one trace apart, each with its own mandate, merchant and currency", async () => {
      // The trace id comes from the intent id, and nothing stops two mandates
      // proposing the same one, so a trace doesn't identify an attempt. A key does.
      const now = new Date();
      const inrMandate = "mnd_crash_shared_inr";
      const usdMandate = "mnd_crash_shared_usd";
      await seedPriorHistory(inrMandate);
      await seedPriorHistory(usdMandate, USD_MERCHANT);
      const inr = buildSignedMandate(inrMandate);
      const usd = buildSignedMandate(usdMandate, "USD", USD_MERCHANT);
      const base = { intent_id: "int_crash_shared", requested_at: "2026-08-28T01:00:00.000Z", agent_rationale: "test" };
      const inner = new SimulatedExecutor();
      const route = routeAllTo(crashesOnCreate(inner));
      await runIntent({ ...base, mandate_id: inrMandate, merchant_id: MERCHANT, line_items: [{ sku: SKU, qty: 1 }] }, inr.signed, inr.publicKeyPem, route, now, "test-model");
      await runIntent({ ...base, mandate_id: usdMandate, merchant_id: USD_MERCHANT, line_items: [{ sku: USD_SKU, qty: 1 }] }, usd.signed, usd.publicKeyPem, route, now, "test-model");
      await backdate("trc_int_crash_shared", now);

      expect(await reconcilePending(routeAllTo(inner), now)).toBe(2);

      const outcomes = await prisma.ledgerEntry.findMany({ where: { traceId: "trc_int_crash_shared", eventType: "outcome" }, orderBy: { seq: "asc" } });
      expect(outcomes.map((row) => row.payload)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ mandate_id: inrMandate, merchant_id: MERCHANT, amount_minor: "5000", currency: "INR" }),
          expect.objectContaining({ mandate_id: usdMandate, merchant_id: USD_MERCHANT, amount_minor: "1250", currency: "USD" }),
        ]),
      );
      const spent = async (mandateId: string) => (await prisma.$transaction((tx) => deriveState(tx, mandateId))).spent_minor;
      expect(await spent(inrMandate)).toBe(6000n);
      expect(await spent(usdMandate)).toBe(2250n);
    });

    it("asks with the currency on the record", async () => {
      const now = new Date();
      const inner = new SimulatedExecutor();
      const traceId = await crashOnce("mnd_crash_record_currency", "int_crash_record_currency", inner, now);
      // Ledger rows can't change, so the record is the side that can differ here.
      await prisma.idempotencyRecord.updateMany({ where: { traceId }, data: { currency: "USD" } });
      const findOrder = vi.spyOn(inner, "findOrder");

      await reconcilePending(routeAllTo(inner), now);

      expect(findOrder).toHaveBeenCalledWith(expect.objectContaining({ currency: "USD" }));
    });

    it("reconciles an order whose call was made at approval", async () => {
      const now = new Date();
      const mandateId = "mnd_crash_approval";
      const { signed, publicKeyPem } = buildSignedMandate(mandateId);
      const intent: PurchaseIntent = { intent_id: "int_crash_approval", mandate_id: mandateId, merchant_id: MERCHANT, line_items: [{ sku: SKU, qty: 1 }], requested_at: "2026-08-28T01:00:00.000Z", agent_rationale: "test" };
      const inner = new SimulatedExecutor();
      const stepped = await runIntent(intent, signed, publicKeyPem, routeAllTo(inner), now, "test-model");
      if (stepped.kind !== "DECIDED" || stepped.approval_id === null) throw new Error("expected a step-up");
      const approved = await resolveApproval(stepped.approval_id, "approve", signed, publicKeyPem, routeAllTo(crashesOnCreate(inner)), now);
      expect(approved.kind).toBe("IN_FLIGHT");
      await backdate("trc_int_crash_approval", now);

      expect(await reconcilePending(routeAllTo(inner), now)).toBe(1);

      const state = await prisma.$transaction((tx) => deriveState(tx, mandateId));
      expect(state.spent_minor).toBe(5000n);
    });

    it("never lets a simulator answer for a live rail", async () => {
      // The simulator has never heard of this order. If it were asked, its "not
      // found" would write a failed outcome, and a real order would stop counting.
      const now = new Date();
      const mandateId = "mnd_crash_wrong_rail";
      const traceId = await crashOnce(mandateId, "int_crash_wrong_rail", crashesOnCreate(new SimulatedExecutor(), "paypal"), now);
      expect((await prisma.idempotencyRecord.findFirst({ where: { traceId } }))?.rail).toBe("paypal");
      const simulator = new SimulatedExecutor();
      const findOrder = vi.spyOn(simulator, "findOrder");
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

      const resolved = await reconcilePending(routeAllTo(simulator), now);

      error.mockRestore();
      expect(resolved).toBe(0);
      expect(findOrder).not.toHaveBeenCalled();
      expect((await prisma.idempotencyRecord.findFirst({ where: { traceId } }))?.status).toBe("pending");
      expect(await prisma.ledgerEntry.count({ where: { traceId, eventType: "outcome" } })).toBe(0);
    });

    it("does not believe a found order in another currency", async () => {
      const now = new Date();
      const inner = new SimulatedExecutor();
      const traceId = await crashOnce("mnd_crash_currency", "int_crash_currency", inner, now);
      const lying: Executor = {
        rail: "simulated",
        createOrder: (req) => inner.createOrder(req),
        findOrder: async (lookup) => {
          const found = await inner.findOrder(lookup);
          return found === null ? null : { ...found, currency: "USD" };
        },
        capture: (req) => inner.capture(req),
      };

      await reconcilePending(routeAllTo(lying), now);

      expect((await prisma.idempotencyRecord.findFirst({ where: { traceId } }))?.status).toBe("succeeded");
      const outcome = await prisma.ledgerEntry.findFirst({ where: { traceId, eventType: "outcome" } });
      expect(outcome?.payload).toMatchObject({
        status: "mismatch",
        amount_minor: "5000",
        currency: "INR",
        rail_currency: "USD",
        failure_code: "RAIL_CURRENCY_MISMATCH",
        reconciled: true,
      });
      // Same answer as if T2 had seen it: the seeded history plus the order that exists.
      const state = await prisma.$transaction((tx) => deriveState(tx, "mnd_crash_currency"));
      expect(state.spent_minor).toBe(6000n);
    });

    it("counts a found order with another amount the same way T2 would", async () => {
      const now = new Date();
      const inner = new SimulatedExecutor();
      const traceId = await crashOnce("mnd_crash_amount", "int_crash_amount", inner, now);
      const lying: Executor = {
        rail: "simulated",
        createOrder: (req) => inner.createOrder(req),
        findOrder: async (lookup) => {
          const found = await inner.findOrder(lookup);
          return found === null ? null : { ...found, amount_minor: minor(1n) };
        },
        capture: (req) => inner.capture(req),
      };

      await reconcilePending(routeAllTo(lying), now);

      const outcome = await prisma.ledgerEntry.findFirst({ where: { traceId, eventType: "outcome" } });
      expect(outcome?.payload).toMatchObject({ status: "mismatch", amount_minor: "5000", rail_amount_minor: "1", failure_code: "RAIL_AMOUNT_MISMATCH", reconciled: true });
      const state = await prisma.$transaction((tx) => deriveState(tx, "mnd_crash_amount"));
      expect(state.spent_minor).toBe(6000n);
    });
  });
});
