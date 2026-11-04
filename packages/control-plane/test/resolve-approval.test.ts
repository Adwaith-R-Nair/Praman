import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@praman/db";
import { append, deriveState } from "@praman/ledger";
import type { PurchaseIntent } from "@praman/policy";
import { generateKeypair, signMandate, type MandateDocument, type SignedMandate } from "@praman/mandate";
import { idempotencyKey, routeAllTo, routeByRail, SimulatedExecutor, type CaptureRequest, type CreateOrderRequest, type ExecOutcome, type Executor, type OrderLookup } from "@praman/exec-core";
import { minor, type Currency, type Rail } from "@praman/shared";
import { runIntent } from "../src/run-intent.js";
import { resolveApproval } from "../src/resolve-approval.js";
import { MANDATE_LOCK_NS } from "../src/run-intent.js";

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

    // The ledger says what was refused and why, in the fields the trace page and
    // the dispute bundle already read, and doesn't say the re-check passed.
    const resolved = await prisma.ledgerEntry.findMany({ where: { traceId: result.trace_id, eventType: "step_up_resolved" } });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.payload).toMatchObject({
      mandate_id: mandateId,
      verdict: "approve",
      revalidated_kind: "DENY",
      revalidated_reason: "AMOUNT_CHANGED_SINCE_APPROVAL",
      detail: "approved 5000, now resolves to 6000",
    });
    expect((await prisma.approval.findUnique({ where: { approvalId } }))?.status).toBe("rejected");
    // A merchant repricing isn't the agent probing the policy (D-20).
    const state = await prisma.$transaction((tx) => deriveState(tx, mandateId));
    expect(state.denied_attempts).toEqual([]);
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

describe("resolveApproval reads the approval's status under the mandate lock", () => {
  const NOW = new Date("2026-09-01T01:00:00.000Z");

  async function waitForLockWaiter(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const [row] = await prisma.$queryRaw<{ waiting: bigint }[]>`SELECT count(*) AS waiting FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
      if (row !== undefined && row.waiting > 0n) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("nothing ever waited on the mandate lock");
  }

  it("a reject that waited behind an approve does not undo it", async () => {
    const mandateId = "mnd_apr_race";
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);
    const intentId = "int_apr_race";
    const approvalId = await stepUp(mandateId, signed, publicKeyPem, intentId);
    const executor = new CountingExecutor(new SimulatedExecutor());

    // Plays the approve that got the lock first: it commits "approved" and its
    // outbox row while the reject is already past its first read, waiting.
    const { resolving } = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MANDATE_LOCK_NS}, hashtext(${mandateId}))`;
      const started = resolveApproval(approvalId, "reject", signed, publicKeyPem, routeAllTo(executor), NOW);
      await waitForLockWaiter();
      await tx.approval.update({ where: { approvalId }, data: { status: "approved", resolvedAt: NOW } });
      await tx.idempotencyRecord.create({
        data: { key: idempotencyKey(mandateId, buildIntent(mandateId, intentId)), traceId: `trc_${intentId}`, status: "pending", receipt: "r", amountMinor: 5000n, rail: "simulated", currency: "INR", outcome: {} },
      });
      return { resolving: started };
    });
    const result = await resolving;

    expect(result).toMatchObject({ kind: "IN_FLIGHT" });
    expect((await prisma.approval.findUnique({ where: { approvalId } }))?.status).toBe("approved");
    expect(await prisma.ledgerEntry.count({ where: { eventType: "step_up_resolved" } })).toBe(0);
    expect(executor.callCount).toBe(0);
  });

  it("a second approve that waited behind a reject gets the rejection", async () => {
    const mandateId = "mnd_apr_race_reject";
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);
    const approvalId = await stepUp(mandateId, signed, publicKeyPem, "int_apr_race_reject");
    const executor = new CountingExecutor(new SimulatedExecutor());

    const { resolving } = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MANDATE_LOCK_NS}, hashtext(${mandateId}))`;
      const started = resolveApproval(approvalId, "approve", signed, publicKeyPem, routeAllTo(executor), NOW);
      await waitForLockWaiter();
      await tx.approval.update({ where: { approvalId }, data: { status: "rejected", resolvedAt: NOW } });
      return { resolving: started };
    });

    expect(await resolving).toMatchObject({ kind: "REJECTED", reason: "already rejected" });
    expect(executor.callCount).toBe(0);
    expect(await prisma.idempotencyRecord.count()).toBe(0);
  });
});

describe("a caller who hasn't proved they hold the mandate changes nothing about the approval", () => {
  const NOW = new Date("2026-09-01T01:00:00.000Z");

  async function attemptRows(traceId: string) {
    const rows = await prisma.ledgerEntry.findMany({ where: { traceId, eventType: "decision" }, orderBy: { seq: "asc" } });
    return rows.slice(1).map((row) => row.payload);
  }

  it("a bad signature can't turn an approved row into a rejected one, and is recorded", async () => {
    const mandateId = "mnd_apr_flip";
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);
    const approvalId = await stepUp(mandateId, signed, publicKeyPem, "int_apr_flip");
    const first = await resolveApproval(approvalId, "approve", signed, publicKeyPem, routeAllTo(new SimulatedExecutor()), NOW);
    expect(first.kind).toBe("EXECUTED");

    const wrongKey = buildSignedMandate(mandateId).publicKeyPem;
    const result = await resolveApproval(approvalId, "approve", signed, wrongKey, routeAllTo(new SimulatedExecutor()), NOW);

    expect(result).toMatchObject({ kind: "REFUSED", reason_code: "MANDATE_SIGNATURE_INVALID" });
    expect((await prisma.approval.findUnique({ where: { approvalId } }))?.status).toBe("approved");
    const rows = await attemptRows("trc_int_apr_flip");
    expect(rows).toEqual([expect.objectContaining({ claimed_mandate_id: mandateId, kind: "DENY", reason_code: "MANDATE_SIGNATURE_INVALID" })]);
    expect(rows[0]).not.toHaveProperty("mandate_id");
  });

  it("a bad signature leaves a pending approval pending, so the real holder can still approve", async () => {
    const mandateId = "mnd_apr_forged_pending";
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);
    const approvalId = await stepUp(mandateId, signed, publicKeyPem, "int_apr_forged_pending");

    const forged = buildSignedMandate(mandateId);
    const refused = await resolveApproval(approvalId, "approve", forged.signed, publicKeyPem, routeAllTo(new SimulatedExecutor()), NOW);
    expect(refused).toMatchObject({ kind: "REFUSED", reason_code: "MANDATE_SIGNATURE_INVALID" });
    expect((await prisma.approval.findUnique({ where: { approvalId } }))?.status).toBe("pending");

    const real = await resolveApproval(approvalId, "approve", signed, publicKeyPem, routeAllTo(new SimulatedExecutor()), NOW);
    expect(real).toMatchObject({ kind: "EXECUTED" });
    // A forged attempt is never counted against the real mandate (D-25).
    const state = await prisma.$transaction((tx) => deriveState(tx, mandateId));
    expect(state.denied_attempts).toEqual([]);
  });

  it.each(["pending", "approved"] as const)("another mandate's good signature can't flip a %s approval", async (status) => {
    const mandateId = `mnd_apr_other_${status}`;
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);
    const approvalId = await stepUp(mandateId, signed, publicKeyPem, `int_apr_other_${status}`);
    if (status === "approved") await resolveApproval(approvalId, "approve", signed, publicKeyPem, routeAllTo(new SimulatedExecutor()), NOW);
    const other = buildSignedMandate(`${mandateId}_someone_else`);
    const executor = new CountingExecutor(new SimulatedExecutor());

    const result = await resolveApproval(approvalId, "approve", other.signed, other.publicKeyPem, routeAllTo(executor), NOW);

    expect(result).toMatchObject({ kind: "REFUSED", reason_code: "MANDATE_SUBJECT_MISMATCH" });
    expect((await prisma.approval.findUnique({ where: { approvalId } }))?.status).toBe(status);
    expect(executor.callCount).toBe(0);
  });
});

describe("an approval is for money in one currency", () => {
  const NOW = new Date("2026-09-01T01:00:00.000Z");

  function signedIn(currency: Currency, mandateId: string, privateKeyPem: string): SignedMandate {
    const doc: MandateDocument = {
      mandate_id: mandateId,
      version: 2,
      issuer_id: "usr_t",
      subject_id: "agt_t",
      scope: { merchant_ids: [MERCHANT], categories: ["food"], currency },
      limits: { max_per_txn_minor: "80000", max_total_minor: "500000", max_txns_per_window: 5, window_seconds: 3600, max_denials_per_window: 5 },
      step_up: { threshold_minor: "50000" },
      validity: { not_before: "2026-08-28T00:00:00.000Z", not_after: "2026-12-31T00:00:00.000Z" },
      nonce: "n1",
    };
    return signMandate(doc, privateKeyPem, "k1");
  }

  async function priceEverythingIn(currency: Currency): Promise<void> {
    await prisma.merchant.update({ where: { merchantId: MERCHANT }, data: { currency } });
    await prisma.catalogItem.update({ where: { merchantId_sku: { merchantId: MERCHANT, sku: SKU } }, data: { currency } });
  }

  it("doesn't carry to the same mandate id re-signed in another currency, at the same digits", async () => {
    // Everything else agrees: the mandate is validly signed, and the merchant and
    // catalog are now USD too. Only the approval still says the human saw rupees.
    const mandateId = "mnd_apr_resigned";
    const { privateKeyPem, publicKeyPem } = generateKeypair();
    const approvalId = await stepUp(mandateId, signedIn("INR", mandateId, privateKeyPem), publicKeyPem, "int_apr_resigned");
    await priceEverythingIn("USD");
    const executor = new CountingExecutor(new SimulatedExecutor());

    const result = await resolveApproval(approvalId, "approve", signedIn("USD", mandateId, privateKeyPem), publicKeyPem, routeAllTo(executor), NOW);

    expect(result).toMatchObject({ kind: "REFUSED", reason_code: "CURRENCY_MISMATCH", detail: "approved in INR, the mandate is now in USD" });
    expect(executor.callCount).toBe(0);
    expect(await prisma.idempotencyRecord.count()).toBe(0);
    expect((await prisma.approval.findUnique({ where: { approvalId } }))?.status).toBe("rejected");
    const resolved = await prisma.ledgerEntry.findFirst({ where: { traceId: "trc_int_apr_resigned", eventType: "step_up_resolved" } });
    expect(resolved?.payload).toMatchObject({ revalidated_kind: "DENY", revalidated_reason: "CURRENCY_MISMATCH" });
  });

  it("is refused when the merchant has moved to another currency by approval time", async () => {
    const mandateId = "mnd_apr_merchant_moved";
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);
    const approvalId = await stepUp(mandateId, signed, publicKeyPem, "int_apr_merchant_moved");
    await prisma.merchant.update({ where: { merchantId: MERCHANT }, data: { currency: "USD" } });
    const executor = new CountingExecutor(new SimulatedExecutor());

    const result = await resolveApproval(approvalId, "approve", signed, publicKeyPem, routeAllTo(executor), NOW);

    expect(result).toMatchObject({ kind: "REFUSED", reason_code: "CURRENCY_MISMATCH" });
    expect(executor.callCount).toBe(0);
    expect(await prisma.idempotencyRecord.count()).toBe(0);
    expect((await prisma.approval.findUnique({ where: { approvalId } }))?.status).toBe("rejected");
  });

  it("approves a USD purchase, and every record of it says USD", async () => {
    const mandateId = "mnd_apr_usd";
    const { privateKeyPem, publicKeyPem } = generateKeypair();
    const signed = signedIn("USD", mandateId, privateKeyPem);
    await priceEverythingIn("USD");
    const approvalId = await stepUp(mandateId, signed, publicKeyPem, "int_apr_usd");
    expect((await prisma.approval.findUnique({ where: { approvalId } }))?.currency).toBe("USD");
    const inner = new SimulatedExecutor();
    const asked: CreateOrderRequest[] = [];
    const executor: Executor = {
      rail: "simulated",
      createOrder: (req) => {
        asked.push(req);
        return inner.createOrder(req);
      },
      findOrder: (lookup) => inner.findOrder(lookup),
      capture: (req) => inner.capture(req),
    };

    const result = await resolveApproval(approvalId, "approve", signed, publicKeyPem, routeAllTo(executor), NOW);

    expect(result).toMatchObject({ kind: "EXECUTED", order_status: "captured" });
    expect(asked).toEqual([expect.objectContaining({ amount_minor: 5000n, currency: "USD" })]);
    expect(await prisma.idempotencyRecord.findFirst({ where: { traceId: "trc_int_apr_usd" } })).toMatchObject({ currency: "USD", amountMinor: 5000n });
    const rows = await prisma.ledgerEntry.findMany({ where: { traceId: "trc_int_apr_usd", eventType: { in: ["api_call", "outcome"] } } });
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.payload).toMatchObject({ amount_minor: "5000", currency: "USD" });
  });
});
