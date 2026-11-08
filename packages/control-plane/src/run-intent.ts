import { randomUUID } from "node:crypto";
import { prisma, loadCatalogSnapshot } from "@praman/db";
import { append, deriveState, maybeCheckpoint } from "@praman/ledger";
import { evaluate, redact, type PurchaseIntent, type AgentVisibleDecision } from "@praman/policy";
import { verifyFailureCode, verifyMandate, type SignedMandate } from "@praman/mandate";
import { acceptOutcome, idempotencyKey, outcomeFields, receiptFor, type AcceptedOutcome, type ExecutorRouter } from "@praman/exec-core";
import { canonical, minorFromDb, minorToJSON } from "@praman/shared";
import { orderProgress } from "./order-view.js";
import { redactionSalt } from "./redaction-salt.js";
import { gateOnRail, routeMerchant } from "./route-merchant.js";

/** Shared with resolve-approval.ts — the same mandate must serialise through the same lock regardless of which path is mutating its state. */
export const MANDATE_LOCK_NS = 42;
/** Below this age, findOrder may not yet see a just-created order. See D-22. */
export const RECONCILE_MIN_AGE_MS = 60_000;

export type RunResult =
  | {
      readonly kind: "DECIDED";
      readonly trace_id: string;
      readonly agent_visible: AgentVisibleDecision;
      readonly internal_reason_code: string;
      readonly order_id: string | null;
      /**
       * null when nothing was ever attempted (DENY/STEP_UP before execution).
       * "mismatch" means an order exists that isn't what was asked for: not paid
       * for by a buyer, not to be retried, and a human needs to look (D-33).
       */
      readonly order_status: AcceptedOutcome["status"] | null;
      /** Set only on a fresh STEP_UP — pass to resolveApproval() to approve or reject. */
      readonly approval_id: string | null;
      /** Set when the rail has a checkout: where the buyer goes to approve the order. */
      readonly approve_url: string | null;
    }
  | {
      readonly kind: "IN_FLIGHT";
      readonly trace_id: string;
      readonly key: string;
      readonly detail: string;
    };

/**
 * Reads a settled idempotency record's cached order out of its JSON outcome.
 * Rows from before rails have no approve_url. A failed record may have no order
 * at all, because the reconciler writes `{}` when the rail found nothing.
 */
export function parseCachedOutcome(
  record: { readonly status: string; readonly outcome: unknown },
  key: string,
): { orderId: string | null; status: AcceptedOutcome["status"]; approveUrl: string | null } {
  const { outcome } = record;
  if (record.status === "failed") {
    const orderId = outcome !== null && typeof outcome === "object" && "order_id" in outcome && typeof outcome.order_id === "string" ? outcome.order_id : null;
    return { orderId, status: "failed", approveUrl: null };
  }
  if (outcome === null || typeof outcome !== "object" || !("order_id" in outcome) || !("status" in outcome)) {
    throw new TypeError(`idempotency record ${key} is succeeded but its outcome is malformed`);
  }
  const raw = outcome as { order_id: unknown; status: unknown; approve_url?: unknown };
  if (raw.status !== "created" && raw.status !== "captured" && raw.status !== "failed" && raw.status !== "mismatch") {
    throw new TypeError(`idempotency record ${key} has an unrecognised cached status: ${String(raw.status)}`);
  }
  return { orderId: String(raw.order_id), status: raw.status, approveUrl: typeof raw.approve_url === "string" ? raw.approve_url : null };
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
  route: ExecutorRouter,
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
      const decision = { kind: "DENY" as const, reason_code: verifyFailureCode(verified.reason), detail: verified.reason };
      // claimed_mandate_id, not mandate_id — the signature never proved the
      // caller owns intent.mandate_id, so this entry must not be queryable as
      // belonging to that mandate. See D-xx.
      await append(tx, {
        traceId,
        ts: now,
        actor: "praman",
        eventType: "decision",
        payload: { claimed_mandate_id: intent.mandate_id, kind: "DENY", reason_code: decision.reason_code, detail: decision.detail },
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
          approval_id: null,
          approve_url: null,
        },
      };
    }

    const mandate = verified.mandate;

    // idempotencyKey() canonicalises the intent, which rejects non-finite or
    // non-integer numbers. That's a malformed intent, not a system failure —
    // it must become a typed DENY, not an uncaught exception that kills the
    // whole request before evaluate() ever gets to classify it properly.
    let key: string;
    try {
      key = idempotencyKey(mandate.mandate_id, intent);
    } catch {
      const decision = { kind: "DENY", reason_code: "AMOUNT_INVALID", detail: "intent is not well-formed" } as const;
      await append(tx, {
        traceId,
        ts: now,
        actor: "praman",
        eventType: "decision",
        payload: { mandate_id: mandate.mandate_id, kind: "DENY", reason_code: decision.reason_code, detail: decision.detail },
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
          approval_id: null,
          approve_url: null,
        },
      };
    }

    // Short-circuit on our OWN record — immune to Razorpay's propagation lag,
    // because it is a row in the same transaction we are already inside.
    //
    // A failed attempt is settled too. This exact intent got its answer, and the
    // same key would reach the same rail, so a repeat gets that answer again. A
    // new attempt is a new intent, with a new key.
    const prior = await tx.idempotencyRecord.findUnique({ where: { key } });
    if (prior?.status === "succeeded" || prior?.status === "failed") {
      if (prior.amountMinor === null) {
        throw new TypeError(`idempotency record ${key} is ${prior.status} but has no amount_minor`);
      }
      const cached = parseCachedOutcome(prior, key);
      // The record says what the create call returned. A checkout order can move on
      // after that, and only the ledger knows (D-40).
      const progress = prior.status === "succeeded" && cached.orderId !== null ? await orderProgress(tx, key, cached.orderId) : null;
      if (progress === "released") {
        // The order is dead, and the rail would answer this key with the same dead
        // order. A new attempt is a new intent with a new key (D-30). Recorded like
        // any DUPLICATE_INTENT, so it counts toward the denial-rate cap.
        const detail = "This intent's checkout was released unpaid. Propose a new intent.";
        await append(tx, {
          traceId: prior.traceId,
          ts: now,
          actor: "praman",
          eventType: "decision",
          payload: { mandate_id: mandate.mandate_id, kind: "DENY", reason_code: "DUPLICATE_INTENT", detail, idempotency_key: key },
        });
        await maybeCheckpoint(tx, now);
        return {
          go: false as const,
          result: {
            kind: "DECIDED" as const,
            trace_id: prior.traceId,
            agent_visible: { kind: "DENY" as const, reason_code: "DUPLICATE_INTENT" as const },
            internal_reason_code: "DUPLICATE_INTENT",
            order_id: null,
            order_status: null,
            approval_id: null,
            approve_url: null,
          },
        };
      }
      return {
        go: false as const,
        result: {
          kind: "DECIDED" as const,
          trace_id: prior.traceId,
          agent_visible: { kind: "ALLOW" as const, amount_minor: minorFromDb(prior.amountMinor) },
          internal_reason_code: "OK",
          order_id: cached.orderId,
          order_status: progress ?? cached.status,
          approval_id: null,
          approve_url: progress === "captured" ? null : cached.approveUrl,
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

    const [state, catalog, routed] = await Promise.all([
      deriveState(tx, mandate.mandate_id),
      loadCatalogSnapshot(tx, intent.merchant_id),
      routeMerchant(tx, intent.merchant_id, route, mandate.scope.currency),
    ]);

    await append(tx, {
      traceId,
      ts: now,
      actor: "agent",
      eventType: "intent",
      // The signed mandate this decision is made under, so a dispute bundle can be checked
      // by someone outside Praman (D-79). Only reached after verifyMandate() passed.
      payload: { ...intent, mandate_id: mandate.mandate_id, idempotency_key: key, model_id: modelId, signed_mandate: { document: signed.document, signature: signed.signature }, public_key_pem: publicKeyPem },
    });

    const gate = gateOnRail(evaluate({ intent, mandate, state, catalog, now, idempotency_key: key }), routed);
    const decision = gate.decision;

    await append(tx, {
      traceId,
      ts: now,
      actor: "praman",
      eventType: "decision",
      payload: {
        mandate_id: mandate.mandate_id,
        kind: decision.kind,
        reason_code: decision.reason_code,
        ...(decision.kind === "DENY"
          ? { detail: decision.detail }
          : { amount_minor: minorToJSON(decision.amount_minor), currency: mandate.scope.currency }),
        // A refusal's detail can name a limit, and a step-up's reason hints at one. Both are withheld from public bundles, and this stops the row's hash confirming a guess.
        ...(decision.kind === "ALLOW" ? {} : redactionSalt()),
      },
    });

    if (decision.kind === "STEP_UP") {
      // A pending record, not just a redacted decision — otherwise there is
      // no way to ever resolve this later. Stores the canonicalised intent
      // (not the raw object) so re-deriving the idempotency key at
      // resolution time produces exactly this `key`, byte for byte. See D-24.
      const approvalId = `apr_${randomUUID()}`;
      await tx.approval.create({
        data: {
          approvalId,
          traceId,
          mandateId: mandate.mandate_id,
          intent: JSON.parse(canonical(intent)) as object,
          amountMinor: decision.amount_minor,
          currency: mandate.scope.currency,
          status: "pending",
        },
      });
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
          approval_id: approvalId,
          approve_url: null,
        },
      };
    }

    if (gate.executor === null) {
      await maybeCheckpoint(tx, now);
      return {
        go: false as const,
        result: {
          kind: "DECIDED" as const,
          trace_id: traceId,
          agent_visible: redact(gate.decision),
          internal_reason_code: gate.decision.reason_code,
          order_id: null,
          order_status: null,
          approval_id: null,
          approve_url: null,
        },
      };
    }

    const executor = gate.executor;
    const receipt = receiptFor(key);

    // The outbox row. Committed BEFORE any external call, so an orphaned
    // order is always accompanied by a record naming its receipt and amount.
    await tx.idempotencyRecord.create({
      data: { key, traceId, status: "pending", receipt, amountMinor: gate.decision.amount_minor, rail: executor.rail, currency: mandate.scope.currency, outcome: {} },
    });
    await append(tx, {
      traceId,
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

    return {
      go: true as const,
      key,
      receipt,
      mandateId: mandate.mandate_id,
      executor,
      amount: gate.decision.amount_minor,
      currency: mandate.scope.currency,
      decision: gate.decision,
    };
  });

  if (!phase1.go) return phase1.result;

  // ── The external call. Outside any transaction, by necessity. ──
  let outcome: AcceptedOutcome;
  try {
    outcome = acceptOutcome(
      await phase1.executor.createOrder({ amount_minor: phase1.amount, currency: phase1.currency, idempotency_key: phase1.key, receipt: phase1.receipt }),
      { amount_minor: phase1.amount, currency: phase1.currency },
    );
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
        ...outcomeFields(outcome),
        merchant_id: intent.merchant_id,
        idempotency_key: phase1.key,
      },
    });
    await tx.idempotencyRecord.update({
      where: { key: phase1.key },
      data: {
        status: outcome.status === "failed" ? "failed" : "succeeded",
        outcome: { order_id: outcome.order_id, status: outcome.status, approve_url: outcome.approve_url },
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
    approval_id: null,
    approve_url: outcome.approve_url,
  };
}
