import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@praman/db";
import { append } from "@praman/ledger";
import type { PurchaseIntent } from "@praman/policy";
import { generateKeypair, signMandate, type MandateDocument } from "@praman/mandate";
import { SimulatedExecutor, type ExecOutcome, type Executor } from "@praman/razorpay-exec";
import type { Paise } from "@praman/shared";
import { runIntent, RECONCILE_MIN_AGE_MS } from "../src/run-intent.js";
import { reconcilePending } from "../src/reconcile.js";

const MERCHANT = "TEST_CRASH_MERCH";
const SKU = "TEST_CRASH_SKU";

/**
 * Wraps a real executor so createOrder actually succeeds against it (a real
 * order/receipt gets recorded there) but then throws — simulating "the
 * external call succeeded but something failed before we could record it,"
 * the exact gap D-22's two-phase restructure exists to close.
 */
class CrashAfterSuccessExecutor implements Executor {
  constructor(private readonly inner: Executor) {}
  async createOrder(amountPaise: Paise, receipt: string): Promise<ExecOutcome> {
    await this.inner.createOrder(amountPaise, receipt);
    throw new Error("SIMULATED_CRASH_AFTER_SUCCESS");
  }
  async findByReceipt(receipt: string) {
    return this.inner.findByReceipt(receipt);
  }
  async capture(paymentId: string, amountPaise: Paise) {
    return this.inner.capture(paymentId, amountPaise);
  }
}

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE ledger_entry, idempotency_record RESTART IDENTITY`;
  await prisma.$executeRaw`DELETE FROM catalog_item WHERE merchant_id = ${MERCHANT}`;
  await prisma.catalogItem.create({
    data: { merchantId: MERCHANT, sku: SKU, title: "t", description: "d", category: "food", pricePaise: 5000n, stockQty: 10 },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

function buildSignedMandate(mandateId: string) {
  const { privateKeyPem, publicKeyPem } = generateKeypair();
  const doc: MandateDocument = {
    mandate_id: mandateId,
    version: 1,
    issuer_id: "usr_t",
    subject_id: "agt_t",
    scope: { merchant_ids: [MERCHANT], categories: ["food"], currency: "INR" },
    limits: { max_per_txn_paise: "80000", max_total_paise: "500000", max_txns_per_window: 5, window_seconds: 3600, max_denials_per_window: 5 },
    step_up: { threshold_paise: "50000" },
    validity: { not_before: "2026-08-28T00:00:00.000Z", not_after: "2026-12-31T00:00:00.000Z" },
    nonce: "n1",
  };
  return { signed: signMandate(doc, privateKeyPem, "k1"), publicKeyPem };
}

async function seedPriorHistory(mandateId: string) {
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
        amount_paise: "1000",
        merchant_id: MERCHANT,
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

    const result = await runIntent(intent, signed, publicKeyPem, crashy, now, "test-model");
    expect(result.kind).toBe("IN_FLIGHT");

    const traceId = `trc_${intent.intent_id}`;
    const record = await prisma.idempotencyRecord.findFirst({ where: { traceId } });
    expect(record?.status).toBe("pending");
    expect(record?.receipt).not.toBeNull();
    expect(record?.amountPaise).toBe(5000n);

    const ledgerRows = await prisma.ledgerEntry.findMany({ where: { traceId }, orderBy: { seq: "asc" } });
    expect(ledgerRows.map((r) => r.eventType)).toEqual(["intent", "decision", "api_call"]);

    // Backdate createdAt directly rather than waiting RECONCILE_MIN_AGE_MS
    // (60s) for real — deterministic, and doesn't slow the suite down.
    await prisma.$executeRaw`UPDATE idempotency_record SET created_at = ${new Date(now.getTime() - RECONCILE_MIN_AGE_MS - 1000)} WHERE key = ${record?.key}`;

    // Reconcile. Uses the plain inner executor — same order/receipt the
    // crashy wrapper already created there.
    const resolved = await reconcilePending(inner, now);
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

    await runIntent(intent, signed, publicKeyPem, crashy, now, "test-model");

    // createdAt (stamped by Postgres just now) is only milliseconds old —
    // well within the propagation-lag window. Must not resolve yet.
    const resolved = await reconcilePending(inner, now);
    expect(resolved).toBe(0);

    const traceId = `trc_${intent.intent_id}`;
    const record = await prisma.idempotencyRecord.findFirst({ where: { traceId } });
    expect(record?.status).toBe("pending");
  });
});
