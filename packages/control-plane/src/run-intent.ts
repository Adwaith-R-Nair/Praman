import { prisma, loadCatalogSnapshot } from "@praman/db";
import { append, deriveState, maybeCheckpoint } from "@praman/ledger";
import { evaluate, redact, type PurchaseIntent, type AgentVisibleDecision } from "@praman/policy";
import { verifyMandate, type SignedMandate } from "@praman/mandate";
import { idempotencyKey, receiptFor, type Executor } from "@praman/razorpay-exec";
import { paiseFromDb, paiseToJSON } from "@praman/shared";

const MANDATE_LOCK_NS = 42;

export interface RunResult {
  readonly trace_id: string;
  readonly agent_visible: AgentVisibleDecision;
  readonly internal_reason_code: string;
  readonly order_id: string | null;
}

/**
 * NOTE: still wraps the Razorpay call inside the same transaction as
 * everything else — that's the dual-write problem D-22 names, and this
 * commit only closes the "ordinary repeated retry" case via the idempotency
 * short-circuit below. The orphaned-order-after-rollback case is real and
 * unresolved here; the next commit restructures into two phases to fix it.
 */
export async function runIntent(
  intent: PurchaseIntent,
  signed: SignedMandate,
  publicKeyPem: string,
  executor: Executor,
  now: Date,
): Promise<RunResult> {
  const traceId = `trc_${intent.intent_id}`;

  return prisma.$transaction(async (tx) => {
    // Serialise evaluation-and-execution per mandate. Two concurrent identical
    // intents would otherwise both read spend before either wrote it. The lock
    // makes the second wait and observe committed state. See D-05.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MANDATE_LOCK_NS}, hashtext(${intent.mandate_id}))`;

    const verified = verifyMandate(signed, publicKeyPem);
    if (!verified.ok) {
      const decision = { kind: "DENY", reason_code: "MANDATE_SIGNATURE_INVALID", detail: verified.reason } as const;
      await append(tx, {
        traceId,
        ts: now,
        actor: "praman",
        eventType: "decision",
        payload: { mandate_id: intent.mandate_id, kind: "DENY", reason_code: decision.reason_code, detail: decision.detail },
      });
      return {
        trace_id: traceId,
        agent_visible: redact(decision),
        internal_reason_code: decision.reason_code,
        order_id: null,
      };
    }

    const mandate = verified.mandate;
    const key = idempotencyKey(mandate.mandate_id, intent);

    // Short-circuit on our OWN record before touching evaluate() or the
    // executor again — immune to Razorpay's propagation lag (see D-22's
    // findByReceipt investigation), since this is our own row read inside the
    // same transaction we already hold the mandate lock in.
    const prior = await tx.idempotencyRecord.findUnique({ where: { key } });
    if (prior?.status === "succeeded") {
      if (prior.amountPaise === null) {
        throw new TypeError(`idempotency record ${key} is succeeded but has no amount_paise`);
      }
      const cached = prior.outcome as { order_id: string; status: string };
      return {
        trace_id: prior.traceId,
        agent_visible: { kind: "ALLOW", amount_paise: paiseFromDb(prior.amountPaise) },
        internal_reason_code: "OK",
        order_id: cached.order_id,
      };
    }

    const [state, catalog] = await Promise.all([
      deriveState(tx, mandate.mandate_id),
      loadCatalogSnapshot(tx, intent.merchant_id),
    ]);

    await append(tx, {
      traceId,
      ts: now,
      actor: "agent",
      eventType: "intent",
      payload: { ...intent, mandate_id: mandate.mandate_id, idempotency_key: key },
    });

    const decision = evaluate({ intent, mandate, state, catalog, now, idempotency_key: key });

    await append(tx, {
      traceId,
      ts: now,
      actor: "praman",
      eventType: "decision",
      payload: {
        mandate_id: mandate.mandate_id,
        kind: decision.kind,
        reason_code: decision.reason_code,
        ...(decision.kind !== "DENY" ? { amount_paise: paiseToJSON(decision.amount_paise) } : { detail: decision.detail }),
      },
    });

    if (decision.kind !== "ALLOW") {
      await maybeCheckpoint(tx, now);
      return {
        trace_id: traceId,
        agent_visible: redact(decision),
        internal_reason_code: decision.reason_code,
        order_id: null,
      };
    }

    const receipt = receiptFor(key);

    // Reconcile before executing. After a prior timeout we cannot know whether
    // the order was created — asking is the only safe move.
    const existing = await executor.findByReceipt(receipt);
    const outcome = existing ?? (await executor.createOrder(decision.amount_paise, receipt));

    await append(tx, {
      traceId,
      ts: now,
      actor: "praman",
      eventType: "api_call",
      payload: {
        mandate_id: mandate.mandate_id,
        provider: "razorpay",
        operation: existing ? "reconciled" : "orders.create",
        receipt,
      },
    });

    await append(tx, {
      traceId,
      ts: now,
      actor: "praman",
      eventType: "outcome",
      payload: {
        mandate_id: mandate.mandate_id,
        status: outcome.status,
        order_id: outcome.order_id,
        payment_id: outcome.payment_id,
        amount_paise: paiseToJSON(outcome.amount_paise),
        merchant_id: intent.merchant_id,
        idempotency_key: key,
      },
    });

    await tx.idempotencyRecord.create({
      data: {
        key,
        traceId,
        status: outcome.status === "failed" ? "failed" : "succeeded",
        receipt,
        amountPaise: decision.amount_paise,
        outcome: { order_id: outcome.order_id, status: outcome.status },
      },
    });
    await maybeCheckpoint(tx, now);

    return {
      trace_id: traceId,
      agent_visible: redact(decision),
      internal_reason_code: "OK",
      order_id: outcome.order_id,
    };
  });
}
