import { prisma, loadCatalogSnapshot } from "@praman/db";
import { append, deriveState, maybeCheckpoint } from "@praman/ledger";
import { evaluate, type PurchaseIntent } from "@praman/policy";
import { verifyFailureCode, verifyMandate, type SignedMandate } from "@praman/mandate";
import { acceptOutcome, idempotencyKey, outcomeFields, receiptFor, type AcceptedOutcome, type ExecutorRouter } from "@praman/exec-core";
import { minorFromDb, minorToJSON } from "@praman/shared";
import { gateOnRail, routeMerchant } from "./route-merchant.js";
import { MANDATE_LOCK_NS, parseCachedOutcome } from "./run-intent.js";

/** A human's attention is not indefinite authority. */
export const APPROVAL_TTL_MS = 15 * 60 * 1000;

export type ResolveResult =
  | {
      readonly kind: "EXECUTED";
      readonly trace_id: string;
      /** Null only when a repeat finds a failed attempt whose order never existed. */
      readonly order_id: string | null;
      /** "mismatch" means an order exists that isn't what was asked for, and a human needs to look (D-33). */
      readonly order_status: AcceptedOutcome["status"];
      /** Set when the rail has a checkout: where the buyer goes to approve the order. */
      readonly approve_url: string | null;
    }
  | { readonly kind: "REJECTED"; readonly trace_id: string; readonly reason: string }
  | { readonly kind: "REFUSED"; readonly trace_id: string; readonly reason_code: string; readonly detail: string }
  | { readonly kind: "IN_FLIGHT"; readonly trace_id: string; readonly detail: string }
  | { readonly kind: "NOT_FOUND"; readonly detail: string };

/**
 * Approval satisfies ONLY the step-up gate, and nothing else. Everything
 * else — revocation, expiry, budget, velocity — is re-evaluated against the
 * mandate and ledger state as they are NOW, not as they were at step-up
 * time. The rejected alternative is executing the stored intent directly:
 * that lets an attacker park a STEP_UP, wait for the mandate to expire or
 * be revoked, then approve, and money moves under dead authority. See D-24.
 */
export async function resolveApproval(
  approvalId: string,
  verdict: "approve" | "reject",
  signed: SignedMandate,
  publicKeyPem: string,
  route: ExecutorRouter,
  now: Date,
): Promise<ResolveResult> {
  const phase1 = await prisma.$transaction(async (tx) => {
    const apr = await tx.approval.findUnique({ where: { approvalId } });
    if (apr === null) return { go: false as const, result: { kind: "NOT_FOUND" as const, detail: approvalId } };
    // "rejected"/"expired" are terminal — refuse outright. "approved" is NOT
    // rejected here: it falls through to the idempotency-record check below,
    // which returns the cached EXECUTED result. Rejecting it here instead
    // would make a second approve() on an already-approved id look like a
    // refusal, when what actually happened is it already succeeded.
    if (apr.status === "rejected" || apr.status === "expired") {
      return {
        go: false as const,
        result: { kind: "REJECTED" as const, trace_id: apr.traceId, reason: `already ${apr.status}` },
      };
    }

    // Same lock namespace as runIntent (D-05) — a fresh purchase attempt and
    // an approval resolution for the same mandate must serialise together,
    // or both could read stale spend before either writes it.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MANDATE_LOCK_NS}, hashtext(${apr.mandateId}))`;

    // Only a still-pending approval can be rejected or expire. An
    // already-"approved" one falls straight through to the idempotency
    // check below regardless of `verdict` or elapsed time — money already
    // moved, and that's the ground truth, not a status this function can
    // retroactively flip.
    if (apr.status === "pending") {
      const expired = now.getTime() - apr.createdAt.getTime() > APPROVAL_TTL_MS;
      if (verdict === "reject" || expired) {
        const reason = expired ? "expired" : "rejected by issuer";
        await tx.approval.update({
          where: { approvalId },
          data: { status: expired ? "expired" : "rejected", resolvedAt: now },
        });
        await append(tx, {
          traceId: apr.traceId,
          ts: now,
          actor: "issuer",
          eventType: "step_up_resolved",
          payload: { mandate_id: apr.mandateId, approval_id: approvalId, verdict: "reject", reason },
        });
        return { go: false as const, result: { kind: "REJECTED" as const, trace_id: apr.traceId, reason } };
      }
    }

    const verified = verifyMandate(signed, publicKeyPem);
    if (!verified.ok) {
      await tx.approval.update({ where: { approvalId }, data: { status: "rejected", resolvedAt: now } });
      return {
        go: false as const,
        result: {
          kind: "REFUSED" as const,
          trace_id: apr.traceId,
          reason_code: verifyFailureCode(verified.reason),
          detail: verified.reason,
        },
      };
    }

    const mandate = verified.mandate;
    const intent = apr.intent as unknown as PurchaseIntent;
    const key = idempotencyKey(mandate.mandate_id, intent);

    // Immune to a second call for the same approval (or races with a fresh
    // purchase attempt that happened to compute the same key) — same
    // short-circuit shape as runIntent, including a failed attempt, so approving
    // twice after a decline gets the decline again and not a second call.
    const prior = await tx.idempotencyRecord.findUnique({ where: { key } });
    if (prior?.status === "succeeded" || prior?.status === "failed") {
      const cached = parseCachedOutcome(prior, key);
      await tx.approval.update({ where: { approvalId }, data: { status: "approved", resolvedAt: now } });
      return {
        go: false as const,
        result: { kind: "EXECUTED" as const, trace_id: apr.traceId, order_id: cached.orderId, order_status: cached.status, approve_url: cached.approveUrl },
      };
    }
    if (prior?.status === "pending") {
      return {
        go: false as const,
        result: { kind: "IN_FLIGHT" as const, trace_id: apr.traceId, detail: "a call for this intent is unresolved; run reconcile" },
      };
    }

    const [state, catalog, routed] = await Promise.all([
      deriveState(tx, mandate.mandate_id),
      loadCatalogSnapshot(tx, intent.merchant_id),
      routeMerchant(tx, intent.merchant_id, route),
    ]);
    const gate = gateOnRail(evaluate({ intent, mandate, state, catalog, now, idempotency_key: key }), routed);
    const decision = gate.decision;

    await append(tx, {
      traceId: apr.traceId,
      ts: now,
      actor: "issuer",
      eventType: "step_up_resolved",
      payload: {
        mandate_id: mandate.mandate_id,
        approval_id: approvalId,
        verdict: "approve",
        revalidated_kind: decision.kind,
        revalidated_reason: decision.reason_code,
      },
    });

    if (gate.executor === null) {
      await tx.approval.update({ where: { approvalId }, data: { status: "rejected", resolvedAt: now } });
      await maybeCheckpoint(tx, now);
      return {
        go: false as const,
        result: { kind: "REFUSED" as const, trace_id: apr.traceId, reason_code: gate.decision.reason_code, detail: gate.decision.detail },
      };
    }
    const executor = gate.executor;

    // The human approved a specific figure. If the catalog moved
    // between step-up and approval, this is no longer the purchase they saw
    // — not ALLOW vs STEP_UP, which approval is what resolves either way.
    const approvedAmount = minorFromDb(apr.amountMinor);
    if (gate.decision.amount_minor !== approvedAmount) {
      await tx.approval.update({ where: { approvalId }, data: { status: "rejected", resolvedAt: now } });
      await maybeCheckpoint(tx, now);
      return {
        go: false as const,
        result: {
          kind: "REFUSED" as const,
          trace_id: apr.traceId,
          reason_code: "AMOUNT_CHANGED_SINCE_APPROVAL",
          detail: `approved ${approvedAmount.toString()}, now resolves to ${gate.decision.amount_minor.toString()}`,
        },
      };
    }

    const receipt = receiptFor(key);
    await tx.idempotencyRecord.create({
      data: { key, traceId: apr.traceId, status: "pending", receipt, amountMinor: gate.decision.amount_minor, rail: executor.rail, currency: mandate.scope.currency, outcome: {} },
    });
    await append(tx, {
      traceId: apr.traceId,
      ts: now,
      actor: "praman",
      eventType: "api_call",
      payload: {
        mandate_id: mandate.mandate_id,
        merchant_id: intent.merchant_id,
        rail: executor.rail,
        operation: "orders.create",
        idempotency_key: key,
        receipt,
        amount_minor: minorToJSON(gate.decision.amount_minor),
        currency: mandate.scope.currency,
        status: "attempted",
      },
    });
    await tx.approval.update({ where: { approvalId }, data: { status: "approved", resolvedAt: now } });

    return {
      go: true as const,
      key,
      receipt,
      traceId: apr.traceId,
      mandateId: mandate.mandate_id,
      merchantId: intent.merchant_id,
      executor,
      amount: gate.decision.amount_minor,
      currency: mandate.scope.currency,
    };
  });

  if (!phase1.go) return phase1.result;

  // Same two-phase structure as runIntent (D-22) — the external call cannot
  // be inside a transaction, so the outbox record was committed before it.
  let outcome: AcceptedOutcome;
  try {
    outcome = acceptOutcome(
      await phase1.executor.createOrder({ amount_minor: phase1.amount, currency: phase1.currency, idempotency_key: phase1.key, receipt: phase1.receipt }),
      { amount_minor: phase1.amount, currency: phase1.currency },
    );
  } catch (err) {
    return { kind: "IN_FLIGHT", trace_id: phase1.traceId, detail: `call failed with unknown outcome: ${String(err)}` };
  }

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MANDATE_LOCK_NS}, hashtext(${phase1.mandateId}))`;
    await append(tx, {
      traceId: phase1.traceId,
      ts: now,
      actor: "praman",
      eventType: "outcome",
      payload: {
        mandate_id: phase1.mandateId,
        ...outcomeFields(outcome),
        merchant_id: phase1.merchantId,
        idempotency_key: phase1.key,
      },
    });
    await tx.idempotencyRecord.update({
      where: { key: phase1.key },
      data: {
        status: outcome.status === "failed" ? "failed" : "succeeded",
        outcome: { order_id: outcome.order_id, status: outcome.status, approve_url: outcome.approve_url },
        updatedAt: now,
      },
    });
    await maybeCheckpoint(tx, now);
  });

  return { kind: "EXECUTED", trace_id: phase1.traceId, order_id: outcome.order_id, order_status: outcome.status, approve_url: outcome.approve_url };
}
