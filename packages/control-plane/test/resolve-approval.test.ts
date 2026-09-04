import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@praman/db";
import { append } from "@praman/ledger";
import type { PurchaseIntent } from "@praman/policy";
import { generateKeypair, signMandate, type MandateDocument, type SignedMandate } from "@praman/mandate";
import { SimulatedExecutor, type ExecOutcome, type Executor } from "@praman/razorpay-exec";
import type { Paise } from "@praman/shared";
import { runIntent } from "../src/run-intent.js";
import { resolveApproval } from "../src/resolve-approval.js";

const MERCHANT = "TEST_APR_MERCH";
const SKU = "TEST_APR_SKU";

/** Counts real calls to createOrder — exactly what "approve twice" is testing. */
class CountingExecutor implements Executor {
  callCount = 0;
  constructor(private readonly inner: Executor) {}
  async createOrder(amountPaise: Paise, receipt: string): Promise<ExecOutcome> {
    this.callCount += 1;
    return this.inner.createOrder(amountPaise, receipt);
  }
  async findByReceipt(receipt: string) {
    return this.inner.findByReceipt(receipt);
  }
  async capture(paymentId: string, amountPaise: Paise) {
    return this.inner.capture(paymentId, amountPaise);
  }
}

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE ledger_entry, idempotency_record, approval RESTART IDENTITY`;
  await prisma.$executeRaw`DELETE FROM catalog_item WHERE merchant_id = ${MERCHANT}`;
  await prisma.catalogItem.create({
    data: { merchantId: MERCHANT, sku: SKU, title: "t", description: "d", category: "food", pricePaise: 5000n, stockQty: 10 },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

function buildSignedMandate(mandateId: string, notAfter = "2026-12-31T00:00:00.000Z"): { signed: SignedMandate; publicKeyPem: string } {
  const { privateKeyPem, publicKeyPem } = generateKeypair();
  const doc: MandateDocument = {
    mandate_id: mandateId,
    version: 1,
    issuer_id: "usr_t",
    subject_id: "agt_t",
    scope: { merchant_ids: [MERCHANT], categories: ["food"], currency: "INR" },
    limits: { max_per_txn_paise: "80000", max_total_paise: "500000", max_txns_per_window: 5, window_seconds: 3600, max_denials_per_window: 5 },
    step_up: { threshold_paise: "50000" },
    validity: { not_before: "2026-08-28T00:00:00.000Z", not_after: notAfter },
    nonce: "n1",
  };
  return { signed: signMandate(doc, privateKeyPem, "k1"), publicKeyPem };
}

function buildIntent(mandateId: string, intentId: string): PurchaseIntent {
  return {
    intent_id: intentId,
    mandate_id: mandateId,
    merchant_id: MERCHANT,
    line_items: [{ sku: SKU, qty: 1 }],
    requested_at: "2026-09-01T01:00:00.000Z",
    agent_rationale: "test",
  };
}

/** Forces a STEP_UP (first-ever transaction with this merchant) and returns the approval id. */
async function stepUp(mandateId: string, signed: SignedMandate, publicKeyPem: string, intentId: string): Promise<string> {
  const result = await runIntent(
    buildIntent(mandateId, intentId),
    signed,
    publicKeyPem,
    new SimulatedExecutor(),
    new Date("2026-09-01T00:00:00.000Z"),
    "test-model",
  );
  if (result.kind !== "DECIDED" || result.agent_visible.kind !== "STEP_UP" || result.approval_id === null) {
    throw new Error(`expected a STEP_UP with an approval_id, got ${JSON.stringify(result)}`);
  }
  return result.approval_id;
}

describe("resolveApproval closes bypasses a naive approve-the-stored-intent would allow", () => {
  it("refuses an approval once the mandate has expired since step-up", async () => {
    const mandateId = "mnd_apr_expired";
    const { signed, publicKeyPem } = buildSignedMandate(mandateId, "2026-09-01T12:00:00.000Z");
    const approvalId = await stepUp(mandateId, signed, publicKeyPem, "int_apr_expired");

    // Approving after the mandate's own not_after — the human is late, and
    // that must matter.
    const result = await resolveApproval(
      approvalId,
      "approve",
      signed,
      publicKeyPem,
      new SimulatedExecutor(),
      new Date("2026-09-02T00:00:00.000Z"),
    );

    expect(result.kind).toBe("REFUSED");
    if (result.kind !== "REFUSED") throw new Error("unreachable");
    expect(result.reason_code).toBe("MANDATE_EXPIRED");

    const idempotencyRecords = await prisma.idempotencyRecord.count();
    expect(idempotencyRecords).toBe(0);
  });

  it("refuses an approval once the mandate has been revoked since step-up", async () => {
    const mandateId = "mnd_apr_revoked";
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);
    const approvalId = await stepUp(mandateId, signed, publicKeyPem, "int_apr_revoked");

    await prisma.$transaction((tx) =>
      append(tx, {
        traceId: "trc_revoke",
        ts: new Date("2026-09-01T00:30:00.000Z"),
        actor: "issuer",
        eventType: "mandate_revoked",
        payload: { mandate_id: mandateId, reason: "test revocation" },
      }),
    );

    const result = await resolveApproval(
      approvalId,
      "approve",
      signed,
      publicKeyPem,
      new SimulatedExecutor(),
      new Date("2026-09-01T01:00:00.000Z"),
    );

    expect(result.kind).toBe("REFUSED");
    if (result.kind !== "REFUSED") throw new Error("unreachable");
    expect(result.reason_code).toBe("MANDATE_REVOKED");
  });

  it("refuses an approval when the catalog price changed since step-up", async () => {
    const mandateId = "mnd_apr_repriced";
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);
    const approvalId = await stepUp(mandateId, signed, publicKeyPem, "int_apr_repriced");

    // The human saw and approved 5000 paise. The merchant changes the price
    // before they click approve.
    await prisma.catalogItem.update({
      where: { merchantId_sku: { merchantId: MERCHANT, sku: SKU } },
      data: { pricePaise: 6000n },
    });

    const result = await resolveApproval(
      approvalId,
      "approve",
      signed,
      publicKeyPem,
      new SimulatedExecutor(),
      new Date("2026-09-01T01:00:00.000Z"),
    );

    expect(result.kind).toBe("REFUSED");
    if (result.kind !== "REFUSED") throw new Error("unreachable");
    expect(result.reason_code).toBe("AMOUNT_CHANGED_SINCE_APPROVAL");

    const idempotencyRecords = await prisma.idempotencyRecord.count();
    expect(idempotencyRecords).toBe(0);
  });

  it("approving twice returns the cached outcome and calls the executor exactly once", async () => {
    const mandateId = "mnd_apr_twice";
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);
    const approvalId = await stepUp(mandateId, signed, publicKeyPem, "int_apr_twice");

    const executor = new CountingExecutor(new SimulatedExecutor());
    const now = new Date("2026-09-01T01:00:00.000Z");

    const first = await resolveApproval(approvalId, "approve", signed, publicKeyPem, executor, now);
    const second = await resolveApproval(approvalId, "approve", signed, publicKeyPem, executor, now);

    expect(executor.callCount).toBe(1);
    expect(first.kind).toBe("EXECUTED");
    expect(second.kind).toBe("EXECUTED");
    if (first.kind !== "EXECUTED" || second.kind !== "EXECUTED") throw new Error("unreachable");
    expect(second.order_id).toBe(first.order_id);
  });

  it("closes the deadlock: a second purchase at the same merchant goes straight to ALLOW after approval", async () => {
    const mandateId = "mnd_apr_deadlock";
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);
    const approvalId = await stepUp(mandateId, signed, publicKeyPem, "int_apr_deadlock_1");

    const approved = await resolveApproval(
      approvalId,
      "approve",
      signed,
      publicKeyPem,
      new SimulatedExecutor(),
      new Date("2026-09-01T01:00:00.000Z"),
    );
    expect(approved.kind).toBe("EXECUTED");

    const second = await runIntent(
      buildIntent(mandateId, "int_apr_deadlock_2"),
      signed,
      publicKeyPem,
      new SimulatedExecutor(),
      new Date("2026-09-01T02:00:00.000Z"),
      "test-model",
    );

    expect(second.kind).toBe("DECIDED");
    if (second.kind !== "DECIDED") throw new Error("unreachable");
    expect(second.agent_visible.kind).toBe("ALLOW");
  });
});
