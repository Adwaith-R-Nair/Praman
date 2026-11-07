import { createHash } from "node:crypto";
import { prisma, type PrismaTx } from "@praman/db";
import { append, deriveState, maybeCheckpoint } from "@praman/ledger";
import { evaluateCapture, type CaptureDecision, type VerifiedMandate } from "@praman/policy";
import { verifyFailureCode, verifyMandate, type SignedMandate } from "@praman/mandate";
import { acceptOutcome, outcomeFields, receiptFor, type AcceptedOutcome, type ExecOutcome, type Executor, type ExecutorRouter } from "@praman/exec-core";
import { currencyFromDb, isRail, minorFromDb, minorFromJSON, minorToJSON, type Currency, type DenyCode, type Minor } from "@praman/shared";
import { readOrderView, type OrderView } from "./order-view.js";
import { MANDATE_LOCK_NS, parseCachedOutcome } from "./run-intent.js";

/** How long a created checkout order holds budget before the release sweep may free it (D-30). */
export const ORDER_HOLD_TTL_MS = 10 * 60 * 1000;

/**
 * PayPal's answer to a capture before the buyer approved, seen live (D-26, D-38). The one
 * refusal taken at its word. Every other refusal is read back first (D-40). Kept here, not
 * imported, so the control plane doesn't depend on a rail. A test pins it to paypal-exec's.
 */
export const ORDER_NOT_APPROVED = "ORDER_NOT_APPROVED";

/**
 * The outbox key for one capture attempt, derived from the order's key and the number of
 * attempts before it. Never random, never supplied. A retry after a definite failure gets
 * a fresh key, so it neither collides with the failed record nor reuses a key PayPal may
 * answer with the old refusal (D-40). The first attempt is sha256("capture|" + orderKey).
 */
export function captureRecordKey(orderKey: string, attempt = 0): string {
  const input = attempt === 0 ? `capture|${orderKey}` : `capture|${orderKey}|${String(attempt)}`;
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export type CaptureResult =
  | { readonly kind: "CAPTURED"; readonly trace_id: string; readonly order_id: string; readonly payment_id: string | null }
  | { readonly kind: "REFUSED"; readonly trace_id: string; readonly reason_code: DenyCode; readonly detail: string }
  /** The rail refused this capture. No money moved, the order still holds budget, and it can be captured again (D-40). */
  | { readonly kind: "FAILED"; readonly trace_id: string; readonly order_id: string; readonly failure_code: string | null }
  /** The rail says it captured, but not the money Praman held. Held against the budget, and a human needs to look (D-33). */
  | { readonly kind: "MISMATCH"; readonly trace_id: string; readonly order_id: string; readonly detail: string }
  | { readonly kind: "IN_FLIGHT"; readonly trace_id: string; readonly detail: string }
  | { readonly kind: "NOT_FOUND"; readonly detail: string };

interface FoundOrder {
  readonly key: string;
  readonly orderId: string;
  readonly rail: string;
  readonly receipt: string;
  readonly authorised: Minor;
  readonly currency: Currency;
}

type Located =
  | { readonly kind: "order"; readonly order: FoundOrder }
  | { readonly kind: "result"; readonly result: CaptureResult };

/**
 * Finds the order this mandate created on this trace, from the outbox record. A trace
 * id comes from the intent id, so another mandate's attempt can share it, and only
 * the intent rows this mandate wrote count.
 */
async function locateOrder(tx: PrismaTx, traceId: string, mandateId: string): Promise<Located> {
  const intents = await tx.ledgerEntry.findMany({
    where: { traceId, eventType: "intent", payload: { path: ["mandate_id"], equals: mandateId } },
    select: { payload: true },
  });
  const keys = intents.flatMap((row) => {
    const payload = row.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return [];
    const key = payload["idempotency_key"];
    return typeof key === "string" ? [key] : [];
  });
  const records = await tx.idempotencyRecord.findMany({ where: { key: { in: keys }, kind: "order" }, orderBy: { createdAt: "desc" } });

  if (records.some((r) => r.status === "pending")) {
    return { kind: "result", result: { kind: "IN_FLIGHT", trace_id: traceId, detail: "the order for this trace is still being created; run reconcile" } };
  }
  const record = records.find((r) => r.status === "succeeded");
  if (record === undefined) {
    const detail = records.length > 0 ? "no order was created for this trace" : "no order for this mandate on this trace";
    return { kind: "result", result: { kind: "NOT_FOUND", detail } };
  }
  const { orderId } = parseCachedOutcome(record, record.key);
  if (orderId === null || record.amountMinor === null || record.receipt === null) {
    return { kind: "result", result: { kind: "NOT_FOUND", detail: `order record ${record.key} names no order` } };
  }
  return {
    kind: "order",
    order: {
      key: record.key,
      orderId,
      rail: record.rail,
      receipt: record.receipt,
      authorised: minorFromDb(record.amountMinor),
      currency: currencyFromDb(record.currency),
    },
  };
}

/** The executor for the rail the order was created on, or null. Never another rail's. */
function executorFor(route: ExecutorRouter, rail: string): Executor | null {
  if (!isRail(rail)) return null;
  const executor = route(rail);
  return executor !== null && executor.rail === rail ? executor : null;
}

/** A mismatch row says the rail answered about other money. Its code becomes the closest reason code. */
function mismatchCode(failureCode: string | null): DenyCode {
  return failureCode === "RAIL_CURRENCY_MISMATCH" ? "CURRENCY_MISMATCH" : "AMOUNT_CHANGED_SINCE_APPROVAL";
}

type Gate =
  | { readonly kind: "ALLOW"; readonly amount: Minor; readonly executor: Executor }
  | { readonly kind: "DENY"; readonly reason_code: DenyCode; readonly detail: string };

/**
 * Policy answers first, as at creation (D-32). evaluateCapture is frozen and trusts the
 * held amount it is given, so the caller makes sure that amount is the ledger's and is
 * one figure. The checks after it can only turn an allow into a refusal.
 */
function gateCapture(
  mandate: VerifiedMandate,
  view: OrderView,
  state: Awaited<ReturnType<typeof deriveState>>,
  quote: { readonly amount_minor: Minor; readonly currency: Currency },
  executor: Executor | null,
  now: Date,
): Gate {
  const [held, other] = view.heldAmounts;
  if (held === undefined || other !== undefined) {
    return { kind: "DENY", reason_code: "AMOUNT_CHANGED_SINCE_APPROVAL", detail: `the ledger holds more than one amount for order ${view.orderId}` };
  }
  const decision: CaptureDecision = evaluateCapture({
    mandate,
    state,
    now,
    order: { idempotency_key: view.key, held_amount_minor: minorFromJSON(held), quoted_amount_minor: quote.amount_minor, currency: quote.currency },
  });
  if (decision.kind === "DENY") return decision;

  // D-33: the rail once answered with other money. Quoting the right figure now doesn't make it the order Praman asked for.
  if (view.mismatch !== null) {
    return { kind: "DENY", reason_code: mismatchCode(view.mismatch.failureCode), detail: `order ${view.orderId} came back as something other than what was asked, and needs a human` };
  }
  if (quote.currency !== view.currency) {
    return { kind: "DENY", reason_code: "CURRENCY_MISMATCH", detail: `the rail quotes ${quote.currency}, the ledger holds ${view.currency}` };
  }
  if (executor === null) {
    return { kind: "DENY", reason_code: "MERCHANT_OUT_OF_SCOPE", detail: `the rail this order was created on has no executor here` };
  }
  return { kind: "ALLOW", amount: decision.amount_minor, executor };
}

/**
 * A caller who hasn't proved they hold a mandate changes nothing. The attempt is
 * recorded as a claim, as runIntent and resolveApproval do (D-25, D-36), and only on a
 * trace that has an order, so a made-up trace id writes nothing.
 */
async function refuseUnproven(traceId: string, claimedMandateId: string, reasonCode: DenyCode, detail: string, now: Date): Promise<CaptureResult> {
  return prisma.$transaction(async (tx) => {
    const hasOrder = await tx.idempotencyRecord.count({ where: { traceId, kind: "order" } });
    if (hasOrder === 0) return { kind: "NOT_FOUND" as const, detail: "no order on this trace" };
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MANDATE_LOCK_NS}, hashtext(${claimedMandateId}))`;
    await append(tx, {
      traceId,
      ts: now,
      actor: "praman",
      eventType: "capture_decision",
      payload: { claimed_mandate_id: claimedMandateId, kind: "DENY", reason_code: reasonCode, detail },
    });
    return { kind: "REFUSED" as const, trace_id: traceId, reason_code: reasonCode, detail };
  });
}

/**
 * Captures a checkout order the buyer has approved, under a fresh check of the mandate
 * (D-31). The same two phases as runIntent (D-22): T1 decides and commits a capture
 * record and an api_call before the rail is called, the call runs outside any
 * transaction, and T2 records what happened.
 *
 * Every ledger row this writes carries the ORDER's key, never the capture record's, or
 * the capture would look like a second order and count the budget twice (D-30). The
 * order id goes on every row too, since one key can hold two orders (D-34).
 */
export async function captureOrder(traceId: string, signed: SignedMandate, publicKeyPem: string, route: ExecutorRouter, now: Date): Promise<CaptureResult> {
  const verified = verifyMandate(signed, publicKeyPem);
  if (!verified.ok) return refuseUnproven(traceId, signed.document.mandate_id, verifyFailureCode(verified.reason), verified.reason, now);
  const mandate = verified.mandate;

  // ── Before T1: find the order, and ask the rail what it now says it is. ──
  // The rail's quote is the one input evaluateCapture takes from outside the ledger,
  // and a network call can't sit inside a transaction holding the mandate lock.
  const first = await prisma.$transaction((tx) => locateOrder(tx, traceId, mandate.mandate_id));
  if (first.kind === "result") return first.result;
  const executor = executorFor(route, first.order.rail);

  let quote: { amount_minor: Minor; currency: Currency } = { amount_minor: first.order.authorised, currency: first.order.currency };
  if (executor !== null) {
    let read: ExecOutcome | null;
    try {
      read = await executor.findOrder({
        receipt: first.order.receipt,
        idempotency_key: first.order.key,
        order_id: first.order.orderId,
        amount_minor: first.order.authorised,
        currency: first.order.currency,
      });
    } catch (err) {
      return { kind: "IN_FLIGHT", trace_id: traceId, detail: `couldn't read order ${first.order.orderId} at the rail, so nothing was captured: ${String(err)}` };
    }
    if (read === null) return { kind: "NOT_FOUND", detail: `the rail has no order ${first.order.orderId}` };
    quote = { amount_minor: read.amount_minor, currency: read.currency };
  }

  // ── T1: decide under the mandate lock, and record the attempt before making it. ──
  const phase1 = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MANDATE_LOCK_NS}, hashtext(${mandate.mandate_id}))`;

    // Again under the lock: a capture, a release or a reconcile may have finished meanwhile.
    const located = await locateOrder(tx, traceId, mandate.mandate_id);
    if (located.kind === "result") return { go: false as const, result: located.result };
    const order = located.order;
    if (order.orderId !== first.order.orderId) {
      return { go: false as const, result: { kind: "IN_FLIGHT" as const, trace_id: traceId, detail: "the order changed while it was being read; try again" } };
    }

    const view = await readOrderView(tx, order.key, order.orderId);
    if (view === null || (!view.created && view.captured === null)) {
      return { go: false as const, result: { kind: "NOT_FOUND" as const, detail: `the ledger has no created order ${order.orderId}` } };
    }
    // A repeat after a capture, such as a double click. Nothing is called and nothing is written.
    if (view.captured !== null) {
      return { go: false as const, result: { kind: "CAPTURED" as const, trace_id: traceId, order_id: order.orderId, payment_id: view.captured.paymentId } };
    }

    const attempts = await tx.idempotencyRecord.findMany({ where: { kind: "capture", orderKey: order.key }, select: { status: true, orderId: true } });
    if (attempts.some((a) => a.status === "pending" && a.orderId === order.orderId)) {
      return { go: false as const, result: { kind: "IN_FLIGHT" as const, trace_id: traceId, detail: "a capture of this order is unresolved; run reconcile" } };
    }

    const state = await deriveState(tx, mandate.mandate_id);
    const gate = gateCapture(mandate, view, state, quote, executor, now);
    const where = { mandate_id: mandate.mandate_id, merchant_id: view.merchantId, idempotency_key: order.key, order_id: order.orderId };

    if (gate.kind === "DENY") {
      // A capture_decision, not a decision: a buyer returning late isn't probing the policy (D-31).
      await append(tx, {
        traceId,
        ts: now,
        actor: "praman",
        eventType: "capture_decision",
        payload: { ...where, kind: "DENY", reason_code: gate.reason_code, detail: gate.detail },
      });
      await maybeCheckpoint(tx, now);
      return { go: false as const, result: { kind: "REFUSED" as const, trace_id: traceId, reason_code: gate.reason_code, detail: gate.detail } };
    }

    const captureKey = captureRecordKey(order.key, attempts.length);
    await tx.idempotencyRecord.create({
      data: {
        key: captureKey,
        traceId,
        status: "pending",
        receipt: receiptFor(order.key),
        amountMinor: gate.amount,
        rail: gate.executor.rail,
        currency: view.currency,
        outcome: {},
        kind: "capture",
        orderKey: order.key,
        orderId: order.orderId,
      },
    });
    await append(tx, {
      traceId,
      ts: now,
      actor: "praman",
      eventType: "capture_decision",
      payload: { ...where, kind: "ALLOW_CAPTURE", reason_code: "OK", amount_minor: minorToJSON(gate.amount), currency: view.currency },
    });
    await append(tx, {
      traceId,
      ts: now,
      actor: "praman",
      eventType: "api_call",
      payload: {
        ...where,
        rail: gate.executor.rail,
        operation: "orders.capture",
        capture_key: captureKey,
        amount_minor: minorToJSON(gate.amount),
        currency: view.currency,
        status: "attempted",
      },
    });
    return { go: true as const, captureKey, where, executor: gate.executor, amount: gate.amount, currency: view.currency };
  });

  if (!phase1.go) return phase1.result;
  const { captureKey, where, amount, currency } = phase1;
  const orderId = where.order_id;

  // ── The rail call. Outside any transaction. ──
  let raw: ExecOutcome;
  try {
    raw = await phase1.executor.capture({ order_id: orderId, amount_minor: amount, currency, idempotency_key: captureKey });
    // Any refusal but the one seen live is read back before it is believed. A code PayPal
    // adds later that means "under way" would otherwise close the record on money that moved (D-39, D-40).
    if (raw.status === "failed" && raw.failure_code !== ORDER_NOT_APPROVED) {
      const read = await phase1.executor.findOrder({ receipt: receiptFor(where.idempotency_key), idempotency_key: where.idempotency_key, order_id: orderId, amount_minor: amount, currency });
      if (read !== null && read.status === "captured") raw = read;
    }
  } catch (err) {
    return { kind: "IN_FLIGHT", trace_id: traceId, detail: `capture call failed with unknown outcome: ${String(err)}` };
  }
  // An answer about another order, or a capture that says the order is merely created, isn't an answer.
  if (raw.order_id !== orderId || raw.status === "created") {
    return { kind: "IN_FLIGHT", trace_id: traceId, detail: `the rail's answer to capturing ${orderId} can't be read as done or refused` };
  }
  const outcome: AcceptedOutcome = acceptOutcome(raw, { amount_minor: amount, currency });

  // ── T2: record what happened. ──
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MANDATE_LOCK_NS}, hashtext(${where.mandate_id}))`;
    await append(tx, {
      traceId,
      ts: now,
      actor: "praman",
      eventType: "outcome",
      payload: { ...outcomeFields(outcome), ...where, capture_key: captureKey },
    });
    await tx.idempotencyRecord.update({
      where: { key: captureKey },
      data: {
        status: outcome.status === "failed" ? "failed" : "succeeded",
        outcome: { order_id: outcome.order_id, status: outcome.status, payment_id: outcome.payment_id, failure_code: outcome.failure_code },
        updatedAt: now,
      },
    });
    await maybeCheckpoint(tx, now);
  });

  switch (outcome.status) {
    case "captured":
      return { kind: "CAPTURED", trace_id: traceId, order_id: orderId, payment_id: outcome.payment_id };
    case "mismatch":
      return { kind: "MISMATCH", trace_id: traceId, order_id: orderId, detail: `the rail reported ${outcome.rail_amount_minor.toString()} ${outcome.rail_currency}, the ledger held ${amount.toString()} ${currency}` };
    default:
      return { kind: "FAILED", trace_id: traceId, order_id: orderId, failure_code: outcome.failure_code };
  }
}
