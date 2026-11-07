import { prisma, loadCatalogSnapshot, type PrismaTx } from "@praman/db";
import { append, deriveState, maybeCheckpoint } from "@praman/ledger";
import { evaluate, type PurchaseIntent } from "@praman/policy";
import { verifyFailureCode, verifyMandate, type SignedMandate } from "@praman/mandate";
import { acceptOutcome, idempotencyKey, outcomeFields, receiptFor, type AcceptedOutcome, type ExecutorRouter } from "@praman/exec-core";
import { minorFromDb, minorToJSON, type Currency, type DenyCode, type Minor } from "@praman/shared";
import { orderProgress } from "./order-view.js";
import { gateOnRail, routeMerchant, type RailGate } from "./route-merchant.js";
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
 * A caller who hasn't proved they hold this approval's mandate changes nothing
 * about it. The status stays as it is, since an approved row means money may have
 * moved and a pending one still belongs to the real holder. The attempt is recorded
 * as a claim, not against the mandate, as runIntent does (D-25).
 */
async function refuseUnproven(tx: PrismaTx, apr: { readonly traceId: string; readonly mandateId: string }, reasonCode: DenyCode, detail: string, now: Date) {
  await append(tx, {
    traceId: apr.traceId,
    ts: now,
    actor: "praman",
    eventType: "decision",
    payload: { claimed_mandate_id: apr.mandateId, kind: "DENY", reason_code: reasonCode, detail },
  });
  return { go: false as const, result: { kind: "REFUSED" as const, trace_id: apr.traceId, reason_code: reasonCode, detail } };
}

/**
 * The human approved a specific figure in a specific currency. If either moved
 * between step-up and approval, this is no longer the purchase they saw. Currency
 * comes first, since 5000 of one is no comparison with 5000 of another. Runs before
 * anything is recorded, so the ledger names this refusal rather than saying the
 * re-check passed.
 */
function bindToApproval(gate: RailGate, approved: { readonly amount: Minor; readonly currency: string }, mandateCurrency: Currency): RailGate {
  if (gate.executor === null) return gate;
  if (approved.currency !== mandateCurrency) {
    return {
      decision: { kind: "DENY", reason_code: "CURRENCY_MISMATCH", detail: `approved in ${approved.currency}, the mandate is now in ${mandateCurrency}` },
      executor: null,
    };
  }
  if (gate.decision.amount_minor !== approved.amount) {
    return {
      decision: {
        kind: "DENY",
        reason_code: "AMOUNT_CHANGED_SINCE_APPROVAL",
        detail: `approved ${approved.amount.toString()}, now resolves to ${gate.decision.amount_minor.toString()}`,
      },
      executor: null,
    };
  }
  return gate;
}

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
    const found = await tx.approval.findUnique({ where: { approvalId } });
    if (found === null) return { go: false as const, result: { kind: "NOT_FOUND" as const, detail: approvalId } };

    // Same lock namespace as runIntent (D-05) — a fresh purchase attempt and
    // an approval resolution for the same mandate must serialise together,
    // or both could read stale spend before either writes it.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MANDATE_LOCK_NS}, hashtext(${found.mandateId}))`;

    // The first read only finds which lock to take. Whoever held the lock may
    // have just resolved this approval, so its status is only true from here on.
    const apr = await tx.approval.findUniqueOrThrow({ where: { approvalId } });

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
    if (!verified.ok) return refuseUnproven(tx, apr, verifyFailureCode(verified.reason), verified.reason, now);
    const mandate = verified.mandate;
    if (mandate.mandate_id !== apr.mandateId) {
      return refuseUnproven(tx, apr, "MANDATE_SUBJECT_MISMATCH", `approval belongs to mandate ${apr.mandateId}, not ${mandate.mandate_id}`, now);
    }

    const intent = apr.intent as unknown as PurchaseIntent;
    const key = idempotencyKey(mandate.mandate_id, intent);

    // Immune to a second call for the same approval (or races with a fresh
    // purchase attempt that happened to compute the same key) — same
    // short-circuit shape as runIntent, including a failed attempt, so approving
    // twice after a decline gets the decline again and not a second call.
    const prior = await tx.idempotencyRecord.findUnique({ where: { key } });
    if (prior?.status === "succeeded" || prior?.status === "failed") {
      const cached = parseCachedOutcome(prior, key);
      // As in runIntent: a released checkout is not sent to the buyer again (D-40).
      // Nothing is recorded, as with the other refusals on this path (D-36).
      const progress = prior.status === "succeeded" && cached.orderId !== null ? await orderProgress(tx, key, cached.orderId) : null;
      if (progress === "released") {
        return {
          go: false as const,
          result: { kind: "REFUSED" as const, trace_id: apr.traceId, reason_code: "DUPLICATE_INTENT", detail: "this approval's checkout was released unpaid" },
        };
      }
      await tx.approval.update({ where: { approvalId }, data: { status: "approved", resolvedAt: now } });
      return {
        go: false as const,
        result: {
          kind: "EXECUTED" as const,
          trace_id: apr.traceId,
          order_id: cached.orderId,
          order_status: progress ?? cached.status,
          approve_url: progress === "captured" ? null : cached.approveUrl,
        },
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
      routeMerchant(tx, intent.merchant_id, route, mandate.scope.currency),
    ]);
    const gate = bindToApproval(
      gateOnRail(evaluate({ intent, mandate, state, catalog, now, idempotency_key: key }), routed),
      { amount: minorFromDb(apr.amountMinor), currency: apr.currency },
      mandate.scope.currency,
    );
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
        ...(decision.kind === "DENY" ? { detail: decision.detail } : {}),
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
