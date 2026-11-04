import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@praman/db";
import { append, deriveState } from "@praman/ledger";
import type { PurchaseIntent } from "@praman/policy";
import { generateKeypair, signMandate, type MandateDocument, type SignedMandate } from "@praman/mandate";
import { routeAllTo, routeByRail, SimulatedExecutor, type CaptureRequest, type CreateOrderRequest, type ExecOutcome, type Executor, type OrderLookup } from "@praman/exec-core";
import { minor, type Rail } from "@praman/shared";
import { runIntent } from "../src/run-intent.js";
import { resolveApproval } from "../src/resolve-approval.js";

const MERCHANT = "TEST_APR_MERCH";
const SKU = "TEST_APR_SKU";

/** Counts real calls to createOrder — exactly what "approve twice" is testing. */
class CountingExecutor implements Executor {
  callCount = 0;
  readonly rail = "simulated";
  constructor(private readonly inner: Executor) {}
  async createOrder(req: CreateOrderRequest): Promise<ExecOutcome> {
    this.callCount += 1;
    return this.inner.createOrder(req);
  }
  async findOrder(lookup: OrderLookup) {
    return this.inner.findOrder(lookup);
  }
  async capture(req: CaptureRequest) {
    return this.inner.capture(req);
  }
}

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE ledger_entry, idempotency_record, approval RESTART IDENTITY`;
  await prisma.$executeRaw`DELETE FROM catalog_item WHERE merchant_id = ${MERCHANT}`;
  await prisma.merchant.upsert({
    where: { merchantId: MERCHANT },
    create: { merchantId: MERCHANT, rail: "simulated", currency: "INR" },
    update: { rail: "simulated", currency: "INR" },
  });
  await prisma.catalogItem.create({
    data: { merchantId: MERCHANT, sku: SKU, title: "t", description: "d", category: "food", currency: "INR", priceMinor: 5000n, stockQty: 10 },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

function buildSignedMandate(mandateId: string, notAfter = "2026-12-31T00:00:00.000Z"): { signed: SignedMandate; publicKeyPem: string } {
  const { privateKeyPem, publicKeyPem } = generateKeypair();
  const doc: MandateDocument = {
    mandate_id: mandateId,
    version: 2,
    issuer_id: "usr_t",
    subject_id: "agt_t",
    scope: { merchant_ids: [MERCHANT], categories: ["food"], currency: "INR" },
    limits: { max_per_txn_minor: "80000", max_total_minor: "500000", max_txns_per_window: 5, window_seconds: 3600, max_denials_per_window: 5 },
    step_up: { threshold_minor: "50000" },
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
    routeAllTo(new SimulatedExecutor()),
    new Date("2026-09-01T00:00:00.000Z"),
    "test-model",
  );
  if (result.kind !== "DECIDED" || result.agent_visible.kind !== "STEP_UP" || result.approval_id === null) {
    throw new Error(`expected a STEP_UP with an approval_id, got ${JSON.stringify(result)}`);
  }
  return result.approval_id;
}

describe("resolveApproval routing", () => {
  it("uses the merchant's rail, and records it", async () => {
    const mandateId = "mnd_apr_route";
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);
    const approvalId = await stepUp(mandateId, signed, publicKeyPem, "int_apr_route");
    const asked: Rail[] = [];

    const result = await resolveApproval(
      approvalId,
      "approve",
      signed,
      publicKeyPem,
      (rail) => {
        asked.push(rail);
        return new SimulatedExecutor();
      },
      new Date("2026-09-01T01:00:00.000Z"),
    );

    expect(asked).toEqual(["simulated"]);
    expect(result).toMatchObject({ kind: "EXECUTED", approve_url: null });
    const record = await prisma.idempotencyRecord.findFirst({ where: { traceId: result.kind === "EXECUTED" ? result.trace_id : "" } });
    expect(record).toMatchObject({ rail: "simulated", currency: "INR" });
  });

  it("refuses with no call when the merchant's rail has no executor by approval time", async () => {
    const mandateId = "mnd_apr_no_rail";
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);
    const approvalId = await stepUp(mandateId, signed, publicKeyPem, "int_apr_no_rail");
    await prisma.merchant.update({ where: { merchantId: MERCHANT }, data: { rail: "paypal" } });

    const result = await resolveApproval(approvalId, "approve", signed, publicKeyPem, routeByRail([]), new Date("2026-09-01T01:00:00.000Z"));

    expect(result).toMatchObject({ kind: "REFUSED", reason_code: "MERCHANT_OUT_OF_SCOPE" });
    expect(await prisma.idempotencyRecord.count()).toBe(0);
    expect((await prisma.approval.findUnique({ where: { approvalId } }))?.status).toBe("rejected");
  });

  it("rejects an outcome whose currency differs from the request", async () => {
    const mandateId = "mnd_apr_wrong_currency";
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);
    const approvalId = await stepUp(mandateId, signed, publicKeyPem, "int_apr_wrong_currency");
    const inner = new SimulatedExecutor();
    const executor: Executor = {
      rail: "simulated",
      createOrder: async (req) => ({ ...(await inner.createOrder(req)), currency: "USD" }),
      findOrder: (lookup) => inner.findOrder(lookup),
      capture: (req) => inner.capture(req),
    };

    const now = new Date("2026-09-01T01:00:00.000Z");
    const result = await resolveApproval(approvalId, "approve", signed, publicKeyPem, routeAllTo(executor), now);

    expect(result).toMatchObject({ kind: "EXECUTED", order_status: "mismatch", approve_url: null });
    const state = await prisma.$transaction((tx) => deriveState(tx, mandateId));
    expect(state.spent_minor).toBe(5000n);
    const again = await resolveApproval(approvalId, "approve", signed, publicKeyPem, routeAllTo(executor), now);
    expect(again).toEqual(result);
  });

  it("holds the approved amount when the rail reports another one", async () => {
    const mandateId = "mnd_apr_wrong_amount";
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);
    const approvalId = await stepUp(mandateId, signed, publicKeyPem, "int_apr_wrong_amount");
    const inner = new SimulatedExecutor();
    const executor: Executor = {
      rail: "simulated",
      createOrder: async (req) => ({ ...(await inner.createOrder(req)), amount_minor: minor(1n) }),
      findOrder: (lookup) => inner.findOrder(lookup),
      capture: (req) => inner.capture(req),
    };

    const result = await resolveApproval(approvalId, "approve", signed, publicKeyPem, routeAllTo(executor), new Date("2026-09-01T01:00:00.000Z"));

    expect(result).toMatchObject({ kind: "EXECUTED", order_status: "mismatch" });
    const state = await prisma.$transaction((tx) => deriveState(tx, mandateId));
    expect(state.spent_minor).toBe(5000n);
  });
});

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
      routeAllTo(new SimulatedExecutor()),
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
      routeAllTo(new SimulatedExecutor()),
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

    // The human saw and approved 5000 minor units. The merchant changes the price
    // before they click approve.
    await prisma.catalogItem.update({
      where: { merchantId_sku: { merchantId: MERCHANT, sku: SKU } },
      data: { priceMinor: 6000n },
    });

    const result = await resolveApproval(
      approvalId,
      "approve",
      signed,
      publicKeyPem,
      routeAllTo(new SimulatedExecutor()),
      new Date("2026-09-01T01:00:00.000Z"),
    );

    expect(result.kind).toBe("REFUSED");
    if (result.kind !== "REFUSED") throw new Error("unreachable");
    expect(result.reason_code).toBe("AMOUNT_CHANGED_SINCE_APPROVAL");

    const idempotencyRecords = await prisma.idempotencyRecord.count();
    expect(idempotencyRecords).toBe(0);
  });

  it("refuses an approval when the catalog's currency changed since step-up, even at the same number", async () => {
    // 5000 paise and 5000 cents have the same digits, so the amount check alone
    // would pass. The human approved ₹50, not $50.
    const mandateId = "mnd_apr_currency";
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);
    const approvalId = await stepUp(mandateId, signed, publicKeyPem, "int_apr_currency");

    await prisma.catalogItem.update({
      where: { merchantId_sku: { merchantId: MERCHANT, sku: SKU } },
      data: { currency: "USD" },
    });

    const result = await resolveApproval(approvalId, "approve", signed, publicKeyPem, routeAllTo(new SimulatedExecutor()), new Date("2026-09-01T01:00:00.000Z"));

    expect(result.kind === "REFUSED" && result.reason_code).toBe("CURRENCY_MISMATCH");
    expect(await prisma.idempotencyRecord.count()).toBe(0);
  });

  it("approving twice returns the cached outcome and calls the executor exactly once", async () => {
    const mandateId = "mnd_apr_twice";
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);
    const approvalId = await stepUp(mandateId, signed, publicKeyPem, "int_apr_twice");

    const executor = new CountingExecutor(new SimulatedExecutor());
    const now = new Date("2026-09-01T01:00:00.000Z");

    const first = await resolveApproval(approvalId, "approve", signed, publicKeyPem, routeAllTo(executor), now);
    const second = await resolveApproval(approvalId, "approve", signed, publicKeyPem, routeAllTo(executor), now);

    expect(executor.callCount).toBe(1);
    expect(first.kind).toBe("EXECUTED");
    expect(second.kind).toBe("EXECUTED");
    if (first.kind !== "EXECUTED" || second.kind !== "EXECUTED") throw new Error("unreachable");
    expect(second.order_id).toBe(first.order_id);
  });

  it("approving twice after a decline returns the same answer and calls the executor once", async () => {
    const mandateId = "mnd_apr_twice_declined";
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);
    const approvalId = await stepUp(mandateId, signed, publicKeyPem, "int_apr_twice_declined");

    const executor = new CountingExecutor(new SimulatedExecutor("declined"));
    const now = new Date("2026-09-01T01:00:00.000Z");

    const first = await resolveApproval(approvalId, "approve", signed, publicKeyPem, routeAllTo(executor), now);
    const second = await resolveApproval(approvalId, "approve", signed, publicKeyPem, routeAllTo(executor), now);

    expect(executor.callCount).toBe(1);
    expect(first).toMatchObject({ kind: "EXECUTED", order_status: "failed" });
    expect(second).toEqual(first);
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
      routeAllTo(new SimulatedExecutor()),
      new Date("2026-09-01T01:00:00.000Z"),
    );
    expect(approved.kind).toBe("EXECUTED");

    const second = await runIntent(
      buildIntent(mandateId, "int_apr_deadlock_2"),
      signed,
      publicKeyPem,
      routeAllTo(new SimulatedExecutor()),
      new Date("2026-09-01T02:00:00.000Z"),
      "test-model",
    );

    expect(second.kind).toBe("DECIDED");
    if (second.kind !== "DECIDED") throw new Error("unreachable");
    expect(second.agent_visible.kind).toBe("ALLOW");
  });
});
