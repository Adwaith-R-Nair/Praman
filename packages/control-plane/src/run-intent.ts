import { prisma, loadCatalogSnapshot } from "@praman/db";
import { append, deriveState, maybeCheckpoint } from "@praman/ledger";
import { evaluate, redact, type PurchaseIntent, type AgentVisibleDecision } from "@praman/policy";
import { verifyMandate, type SignedMandate } from "@praman/mandate";
import { idempotencyKey, receiptFor, type ExecOutcome, type Executor } from "@praman/razorpay-exec";
import { paiseFromDb, paiseToJSON } from "@praman/shared";

const MANDATE_LOCK_NS = 42;
/** Below this age, findByReceipt may not yet see a just-created order. See D-22. */
export const RECONCILE_MIN_AGE_MS = 60_000;

export type RunResult =
  | {
      readonly kind: "DECIDED";
      readonly trace_id: string;
      readonly agent_visible: AgentVisibleDecision;
      readonly internal_reason_code: string;
      readonly order_id: string | null;
      /** null when nothing was ever attempted (DENY/STEP_UP before execution). */
      readonly order_status: ExecOutcome["status"] | null;
    }
  | {
      readonly kind: "IN_FLIGHT";
      readonly trace_id: string;
      readonly key: string;
      readonly detail: string;
    };

/** Reads a settled idempotency record's cached order id out of its JSON outcome. */
function parseCachedOutcome(outcome: unknown, key: string): { orderId: string; status: ExecOutcome["status"] } {
  if (outcome === null || typeof outcome !== "object" || !("order_id" in outcome) || !("status" in outcome)) {
    throw new TypeError(`idempotency record ${key} is succeeded but its outcome is malformed`);
  }
  const raw = outcome as { order_id: unknown; status: unknown };
  if (raw.status !== "created" && raw.status !== "captured" && raw.status !== "failed") {
    throw new TypeError(`idempotency record ${key} has an unrecognised cached status: ${String(raw.status)}`);
  }
  return { orderId: String(raw.order_id), status: raw.status };
}

/**
 * Two phases with the external call between them, not one transaction around
 * it. A database transaction and a call to Razorpay cannot be made atomic —
 * there is no protocol between them (the dual-write problem). What's
 * achievable instead: no external call is ever made without a durable,
 * committed record that it was about to be made. See D-22.
 */
export async function runIntent(
  intent: PurchaseIntent,
  signed: SignedMandate,
  publicKeyPem: string,
  executor: Executor,
  now: Date,
  /**
   * Which model proposed this intent. Not part of PurchaseIntent itself —
   * evaluate() doesn't care which model produced a proposal, only what it
   * contains. Provenance is orchestration metadata, recorded on the ledger's
   * `intent` event so a result is never separable from the model that made it.
   */
  modelId: string,
): Promise<RunResult> {
  const traceId = `trc_${intent.intent_id}`;

  // ── T1: decide, and durably record the intent to call, before calling ──
  const phase1 = await prisma.$transaction(async (tx) => {
    // Serialise evaluation-and-execution per mandate. Two concurrent identical
    // intents would otherwise both read spend before either wrote it. See D-05.
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
        go: false as const,
        result: {
          kind: "DECIDED" as const,
          trace_id: traceId,
          agent_visible: redact(decision),
          internal_reason_code: decision.reason_code,
          order_id: null,
          order_status: null,
        },
      };
    }

    const mandate = verified.mandate;
    const key = idempotencyKey(mandate.mandate_id, intent);

    // Short-circuit on our OWN record — immune to Razorpay's propagation lag,
    // because it is a row in the same transaction we are already inside.
    const prior = await tx.idempotencyRecord.findUnique({ where: { key } });
    if (prior?.status === "succeeded") {
      if (prior.amountPaise === null) {
        throw new TypeError(`idempotency record ${key} is succeeded but has no amount_paise`);
      }
      const cached = parseCachedOutcome(prior.outcome, key);
      return {
        go: false as const,
        result: {
          kind: "DECIDED" as const,
          trace_id: prior.traceId,
          agent_visible: { kind: "ALLOW" as const, amount_paise: paiseFromDb(prior.amountPaise) },
          internal_reason_code: "OK",
          order_id: cached.orderId,
          order_status: cached.status,
        },
      };
    }
    if (prior?.status === "pending") {
      // A call for this exact cart is unresolved. Do NOT call again.
      return {
        go: false as const,
        result: {
          kind: "IN_FLIGHT" as const,
          trace_id: prior.traceId,
          key,
          detail: "a call for this intent is unresolved; run reconcile",
        },
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
      payload: { ...intent, mandate_id: mandate.mandate_id, idempotency_key: key, model_id: modelId },
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
        ...(decision.kind === "DENY" ? { detail: decision.detail } : { amount_paise: paiseToJSON(decision.amount_paise) }),
      },
    });

    if (decision.kind !== "ALLOW") {
      await maybeCheckpoint(tx, now);
      return {
        go: false as const,
        result: {
          kind: "DECIDED" as const,
          trace_id: traceId,
          agent_visible: redact(decision),
          internal_reason_code: decision.reason_code,
          order_id: null,
          order_status: null,
        },
      };
    }

    const receipt = receiptFor(key);

    // The outbox row. Committed BEFORE any external call, so an orphaned
    // order is always accompanied by a record naming its receipt and amount.
    await tx.idempotencyRecord.create({
      data: { key, traceId, status: "pending", receipt, amountPaise: decision.amount_paise, outcome: {} },
    });
    await append(tx, {
      traceId,
      ts: now,
      actor: "praman",
      eventType: "api_call",
      payload: {
        mandate_id: mandate.mandate_id,
        provider: "razorpay",
        operation: "orders.create",
        receipt,
        amount_paise: paiseToJSON(decision.amount_paise),
        status: "attempted",
      },
    });

    return {
      go: true as const,
      key,
      receipt,
      mandateId: mandate.mandate_id,
      amount: decision.amount_paise,
      decision,
    };
  });

  if (!phase1.go) return phase1.result;

  // ── The external call. Outside any transaction, by necessity. ──
  let outcome: ExecOutcome;
  try {
    outcome = await executor.createOrder(phase1.amount, phase1.receipt);
  } catch (err) {
    // We do NOT know whether the order was created. Leave the record pending.
    return {
      kind: "IN_FLIGHT",
      trace_id: traceId,
      key: phase1.key,
      detail: `call failed with unknown outcome: ${String(err)}`,
    };
  }

  // ── T2: record the outcome ──
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MANDATE_LOCK_NS}, hashtext(${phase1.mandateId}))`;
    await append(tx, {
      traceId,
      ts: now,
      actor: "praman",
      eventType: "outcome",
      payload: {
        mandate_id: phase1.mandateId,
        status: outcome.status,
        order_id: outcome.order_id,
        payment_id: outcome.payment_id,
        amount_paise: paiseToJSON(outcome.amount_paise),
        merchant_id: intent.merchant_id,
        idempotency_key: phase1.key,
      },
    });
    await tx.idempotencyRecord.update({
      where: { key: phase1.key },
      data: {
        status: outcome.status === "failed" ? "failed" : "succeeded",
        outcome: { order_id: outcome.order_id, status: outcome.status },
        updatedAt: new Date(),
      },
    });
    await maybeCheckpoint(tx, now);
  });

  return {
    kind: "DECIDED",
    trace_id: traceId,
    agent_visible: redact(phase1.decision),
    internal_reason_code: "OK",
    order_id: outcome.order_id,
    order_status: outcome.status,
  };
}
