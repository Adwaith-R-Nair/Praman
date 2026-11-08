import { createHash } from "node:crypto";
import { prisma, type PrismaTx } from "@praman/db";
import { append, maybeCheckpoint } from "@praman/ledger";
import { acceptRefund, refundFields, type AcceptedRefund, type Executor, type ExecutorRouter, type RefundOutcome, type RefundRequest } from "@praman/exec-core";
import { minorFromDb, minorFromJSON, minorToJSON, type Currency, type Minor } from "@praman/shared";
import { executorFor } from "./capture-order.js";
import { readOrderView } from "./order-view.js";
import { MANDATE_LOCK_NS, parseCachedOutcome } from "./run-intent.js";

/**
 * Who asked for a refund. Only a person can: an operator with `pnpm refund`, or a
 * demo visitor on their own session's trace page. Nothing an agent or a model can
 * reach calls refundOrder (D-66), and `pnpm lint:boundary` checks that.
 */
export type RefundRequester = "operator" | "demo_visitor";

export interface RefundAsk {
  readonly traceId: string;
  /**
   * The mandates whose orders this caller may refund: a demo visitor's own two. Null
   * for the operator, who may refund any order on the ledger.
   */
  readonly mandateIds: readonly string[] | null;
  readonly requestedBy: RefundRequester;
}

/** Why there is nothing to refund. A closed list, each with a fixed sentence in `detail`. */
export type CannotRefund = "not_found" | "not_captured" | "mismatch" | "several_orders" | "rail_cannot_refund";

export type RefundResult =
  | { readonly kind: "REFUNDED"; readonly trace_id: string; readonly order_id: string; readonly payment_id: string; readonly refund_id: string | null; readonly amount_minor: Minor; readonly currency: Currency }
  /** The rail accepted the refund and hasn't finished. The reconciler follows it up. */
  | { readonly kind: "PENDING"; readonly trace_id: string; readonly order_id: string; readonly refund_id: string | null }
  /** The rail refused this refund. No money went back, and it can be asked again. */
  | { readonly kind: "FAILED"; readonly trace_id: string; readonly order_id: string; readonly failure_code: string | null }
  /** The rail answered about other money than Praman asked to give back. A person needs to look. */
  | { readonly kind: "MISMATCH"; readonly trace_id: string; readonly order_id: string; readonly detail: string }
  | { readonly kind: "IN_FLIGHT"; readonly trace_id: string; readonly detail: string }
  | { readonly kind: "CANNOT_REFUND"; readonly trace_id: string; readonly why: CannotRefund; readonly detail: string };

/**
 * The outbox key for one refund attempt, derived from the order's key, the captured
 * payment and the number of attempts before it. Never random, never supplied. A retry
 * after a definite refusal gets a fresh key, so it can't collide with the failed record,
 * as with captures (D-40).
 */
export function refundRecordKey(orderKey: string, paymentId: string, attempt = 0): string {
  const input = `refund|${orderKey}|${paymentId}${attempt === 0 ? "" : `|${String(attempt)}`}`;
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** A captured order, as the ledger records it. */
interface Refundable {
  readonly key: string;
  readonly orderId: string;
  readonly mandateId: string;
  readonly merchantId: string;
  readonly rail: string;
  readonly paymentId: string;
  readonly amount: Minor;
  readonly currency: Currency;
}

type Located = { readonly kind: "order"; readonly order: Refundable } | { readonly kind: "result"; readonly result: RefundResult };

const cannot = (traceId: string, why: CannotRefund, detail: string): Located => ({ kind: "result", result: { kind: "CANNOT_REFUND", trace_id: traceId, why, detail } });

/**
 * Finds the one captured order on this trace, from the intent rows, the order records
 * and the ledger's outcome rows. Scoped to the given mandates when there are any. A
 * trace id comes from the intent id, so two mandates can share one, and a trace with two
 * captured orders is refused rather than guessed at.
 */
async function locateCaptured(tx: PrismaTx, ask: RefundAsk): Promise<Located> {
  const intents = await tx.ledgerEntry.findMany({ where: { traceId: ask.traceId, eventType: "intent" }, select: { payload: true } });
  const keys = intents.flatMap((row) => {
    const p = row.payload;
    if (p === null || typeof p !== "object" || Array.isArray(p)) return [];
    const key = p["idempotency_key"];
    const mandate = p["mandate_id"];
    if (typeof key !== "string" || typeof mandate !== "string") return [];
    return ask.mandateIds === null || ask.mandateIds.includes(mandate) ? [key] : [];
  });
  const records = await tx.idempotencyRecord.findMany({ where: { key: { in: keys }, kind: "order" }, orderBy: { createdAt: "asc" } });
  if (records.length === 0) return cannot(ask.traceId, "not_found", "There is no order on this trace that you can refund.");

  const found: Refundable[] = [];
  let mismatch = false;
  for (const record of records) {
    if (record.status !== "succeeded") continue;
    const { orderId } = parseCachedOutcome(record, record.key);
    if (orderId === null) continue;
    const view = await readOrderView(tx, record.key, orderId);
    if (view === null) continue;
    if (view.mismatch !== null) {
      mismatch = true;
      continue;
    }
    if (view.captured === null || view.captured.paymentId === null) continue;
    found.push({
      key: record.key,
      orderId,
      mandateId: view.mandateId,
      merchantId: view.merchantId,
      rail: record.rail,
      paymentId: view.captured.paymentId,
      amount: minorFromJSON(view.captured.amountMinor),
      currency: view.currency,
    });
  }

  const [only, other] = found;
  if (other !== undefined) return cannot(ask.traceId, "several_orders", "This trace has more than one paid order, so Praman won't guess which to refund. A person should look at the ledger.");
  if (only !== undefined) return { kind: "order", order: only };
  if (mismatch) return cannot(ask.traceId, "mismatch", "The payment provider reported this order as different money than Praman asked for. A person needs to look at it with the provider before any refund.");
  if (records.some((r) => r.status === "pending")) {
    return { kind: "result", result: { kind: "IN_FLIGHT", trace_id: ask.traceId, detail: "The order on this trace is still being settled. Nothing was refunded." } };
  }
  return cannot(ask.traceId, "not_captured", "Nothing on this trace was paid, so there is nothing to refund.");
}

/** The rail's refund, or null when this process can't refund on that rail. */
function refunderFor(route: ExecutorRouter, rail: string): { readonly executor: Executor; readonly refund: (req: RefundRequest) => Promise<RefundOutcome> } | null {
  const executor = executorFor(route, rail);
  const refund = executor?.refund;
  if (executor === null || refund === undefined) return null;
  return { executor, refund: (req) => refund.call(executor, req) };
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * What the ledger already says about refunding this order: the newest attempt whose
 * own latest outcome isn't a failure. An attempt is judged by its last row, so one
 * that was pending and then failed counts as failed. A failed refund moved no money,
 * so it doesn't stop another.
 */
async function standingRefund(tx: PrismaTx, order: Refundable, traceId: string): Promise<RefundResult | null> {
  const rows = await tx.$queryRaw<{ payload: Record<string, unknown> }[]>`
    SELECT payload FROM ledger_entry
    WHERE event_type = 'refund_outcome'
      AND payload->>'idempotency_key' = ${order.key}
      AND payload->>'order_id' = ${order.orderId}
    ORDER BY seq DESC
  `;
  const seen = new Set<string | null>();
  for (const { payload } of rows) {
    const key = str(payload["refund_key"]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (payload["status"] !== "failed") return fromLedger(traceId, order, payload);
  }
  return null;
}

function fromLedger(traceId: string, order: Refundable, p: Record<string, unknown>): RefundResult {
  const refundId = str(p["refund_id"]);
  switch (p["status"]) {
    case "refunded":
      return { kind: "REFUNDED", trace_id: traceId, order_id: order.orderId, payment_id: order.paymentId, refund_id: refundId, amount_minor: order.amount, currency: order.currency };
    case "pending":
      return { kind: "PENDING", trace_id: traceId, order_id: order.orderId, refund_id: refundId };
    case "mismatch":
      return { kind: "MISMATCH", trace_id: traceId, order_id: order.orderId, detail: "The payment provider reported a refund of other money than Praman asked for. A person needs to look." };
    default:
      return { kind: "FAILED", trace_id: traceId, order_id: order.orderId, failure_code: str(p["failure_code"]) };
  }
}

function fromOutcome(traceId: string, order: Refundable, outcome: AcceptedRefund): RefundResult {
  switch (outcome.status) {
    case "refunded":
      return { kind: "REFUNDED", trace_id: traceId, order_id: order.orderId, payment_id: order.paymentId, refund_id: outcome.refund_id, amount_minor: order.amount, currency: order.currency };
    case "pending":
      return { kind: "PENDING", trace_id: traceId, order_id: order.orderId, refund_id: outcome.refund_id };
    case "mismatch":
      return {
        kind: "MISMATCH",
        trace_id: traceId,
        order_id: order.orderId,
        detail: `The payment provider reported a refund of ${outcome.rail_amount_minor.toString()} ${outcome.rail_currency}; Praman asked for ${order.amount.toString()} ${order.currency}. A person needs to look.`,
      };
    case "failed":
      return { kind: "FAILED", trace_id: traceId, order_id: order.orderId, failure_code: outcome.failure_code };
  }
}

/**
 * The record's status once an outcome is written. A pending refund keeps its record
 * pending, so the reconciler sends the same request again until the rail finishes it.
 */
function recordStatus(outcome: AcceptedRefund): "pending" | "succeeded" | "failed" {
  if (outcome.status === "pending") return "pending";
  return outcome.status === "failed" ? "failed" : "succeeded";
}

/**
 * Gives back the whole of one captured payment, when a person asks (D-66). The same
 * two phases as every money action (D-22): T1 takes the mandate lock, checks the ledger,
 * and commits a pending refund record and a refund_requested row before the rail is
 * called; the call runs outside any transaction; T2 appends one refund_outcome and
 * settles the record. A lost answer leaves the record pending, and the reconciler sends
 * the same request again under the same PayPal-Request-Id, which PayPal answers with the
 * same refund (D-68).
 *
 * Nothing about the mandate is re-checked. A refund is not the agent spending: it can't
 * be started by an agent, it sends money back to the person the mandate protects, and a
 * revoked or expired mandate is no reason to keep their money. And it gives back no
 * budget, whatever happens to it (D-67).
 *
 * Every row carries the ORDER's key and order id, like a capture (D-30, D-34). The
 * refund's own key is kept as refund_key.
 */
export async function refundOrder(ask: RefundAsk, route: ExecutorRouter, now: Date): Promise<RefundResult> {
  const traceId = ask.traceId;

  // ── Before T1: is there one captured order, and can this process refund on its rail? ──
  const first = await prisma.$transaction((tx) => locateCaptured(tx, ask));
  if (first.kind === "result") return first.result;
  const refunder = refunderFor(route, first.order.rail);
  if (refunder === null) return { kind: "CANNOT_REFUND", trace_id: traceId, why: "rail_cannot_refund", detail: "This server can't refund on the rail this order was paid on. Nothing was refunded." };

  // ── T1: decide under the mandate lock, and record the attempt before making it. ──
  const phase1 = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MANDATE_LOCK_NS}, hashtext(${first.order.mandateId}))`;

    // Again under the lock: another request, the reconciler or a T2 may have finished meanwhile.
    const located = await locateCaptured(tx, ask);
    if (located.kind === "result") return { go: false as const, result: located.result };
    const order = located.order;
    if (order.orderId !== first.order.orderId || order.paymentId !== first.order.paymentId) {
      return { go: false as const, result: { kind: "IN_FLIGHT" as const, trace_id: traceId, detail: "The order changed while it was being read. Nothing was refunded; try again." } };
    }

    const attempts = await tx.idempotencyRecord.findMany({ where: { kind: "refund", orderKey: order.key, orderId: order.orderId }, select: { status: true } });
    // A refund PayPal reported as pending is on the ledger and its record is still
    // pending, so the ledger answers first: it is a refund under way, not a lost call.
    const standing = await standingRefund(tx, order, traceId);
    if (standing !== null) return { go: false as const, result: standing };
    if (attempts.some((a) => a.status === "pending")) {
      return { go: false as const, result: { kind: "IN_FLIGHT" as const, trace_id: traceId, detail: "A refund of this order has no answer yet. Praman won't send another; the reconcile sweep settles it." } };
    }

    const refundKey = refundRecordKey(order.key, order.paymentId, attempts.length);
    await tx.idempotencyRecord.create({
      data: {
        key: refundKey,
        traceId,
        status: "pending",
        receipt: null,
        amountMinor: order.amount,
        rail: order.rail,
        currency: order.currency,
        outcome: {},
        kind: "refund",
        orderKey: order.key,
        orderId: order.orderId,
      },
    });
    await append(tx, {
      traceId,
      ts: now,
      actor: ask.requestedBy,
      eventType: "refund_requested",
      payload: {
        mandate_id: order.mandateId,
        merchant_id: order.merchantId,
        idempotency_key: order.key,
        order_id: order.orderId,
        payment_id: order.paymentId,
        refund_key: refundKey,
        rail: order.rail,
        operation: "captures.refund",
        amount_minor: minorToJSON(order.amount),
        currency: order.currency,
        status: "attempted",
        requested_by: ask.requestedBy,
      },
    });
    return { go: true as const, order, refundKey };
  });

  if (!phase1.go) return phase1.result;
  const { order, refundKey } = phase1;

  // ── The rail call. Outside any transaction. ──
  let outcome: AcceptedRefund;
  try {
    const raw = await refunder.refund({ payment_id: order.paymentId, amount_minor: order.amount, currency: order.currency, idempotency_key: refundKey });
    if (raw.payment_id !== order.paymentId) throw new Error(`the rail answered about payment ${raw.payment_id}, not ${order.paymentId}`);
    outcome = acceptRefund(raw, { amount_minor: order.amount, currency: order.currency });
  } catch (err) {
    return { kind: "IN_FLIGHT", trace_id: traceId, detail: `The refund call has no answer Praman can read, so it stays open and the reconcile sweep settles it: ${String(err)}` };
  }

  // ── T2: record what happened, unless the reconciler settled it meanwhile. ──
  const settled = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MANDATE_LOCK_NS}, hashtext(${order.mandateId}))`;
    const current = await tx.idempotencyRecord.findUnique({ where: { key: refundKey }, select: { status: true } });
    if (current?.status !== "pending") {
      const written = await tx.ledgerEntry.findFirst({ where: { eventType: "refund_outcome", payload: { path: ["refund_key"], equals: refundKey } }, orderBy: { seq: "desc" } });
      const p = written?.payload;
      if (p !== null && p !== undefined && typeof p === "object" && !Array.isArray(p)) return fromLedger(traceId, order, p);
      return { kind: "IN_FLIGHT" as const, trace_id: traceId, detail: "This refund was settled elsewhere while its answer was coming back. The ledger trace shows what was recorded." };
    }
    await writeRefundOutcome(tx, { traceId, order, refundKey, outcome, actor: "praman", reconciled: false, now });
    return null;
  });
  return settled ?? fromOutcome(traceId, order, outcome);
}

async function writeRefundOutcome(
  tx: PrismaTx,
  w: { readonly traceId: string; readonly order: Pick<Refundable, "key" | "orderId" | "mandateId" | "merchantId">; readonly refundKey: string; readonly outcome: AcceptedRefund; readonly actor: string; readonly reconciled: boolean; readonly now: Date },
): Promise<void> {
  await append(tx, {
    traceId: w.traceId,
    ts: w.now,
    actor: w.actor,
    eventType: "refund_outcome",
    payload: {
      ...refundFields(w.outcome),
      mandate_id: w.order.mandateId,
      merchant_id: w.order.merchantId,
      idempotency_key: w.order.key,
      order_id: w.order.orderId,
      refund_key: w.refundKey,
      ...(w.reconciled ? { reconciled: true } : {}),
    },
  });
  await tx.idempotencyRecord.update({
    where: { key: w.refundKey },
    data: {
      status: recordStatus(w.outcome),
      outcome: { status: w.outcome.status, refund_id: w.outcome.refund_id, failure_code: w.outcome.failure_code },
      updatedAt: w.now,
    },
  });
  await maybeCheckpoint(tx, w.now);
}

type PendingRecord = Awaited<ReturnType<typeof prisma.idempotencyRecord.findMany>>[number];

/**
 * Settles a refund record left pending: by a lost answer, a crash, or PayPal saying
 * PENDING. It sends the same request again under the record's own key, which PayPal
 * answers with the refund it already made, or makes now if the first never arrived
 * (D-68). That refund was decided in T1, at a person's request; this only finishes it.
 *
 * Still pending at the rail: nothing is written if the ledger already says pending, and
 * the record stays open. Returns whether the record was settled.
 */
export async function reconcileRefund(rec: PendingRecord, route: ExecutorRouter, now: Date): Promise<boolean> {
  if (rec.orderKey === null || rec.orderId === null) throw new TypeError(`refund record ${rec.key} names no order`);
  if (rec.amountMinor === null) throw new TypeError(`refund record ${rec.key} has no amount_minor`);
  const requested = await prisma.ledgerEntry.findFirst({ where: { traceId: rec.traceId, eventType: "refund_requested", payload: { path: ["refund_key"], equals: rec.key } } });
  const p = requested?.payload;
  if (p === null || p === undefined || typeof p !== "object" || Array.isArray(p)) throw new Error(`no refund_requested row for ${rec.key}`);
  const paymentId = str(p["payment_id"]);
  const mandateId = str(p["mandate_id"]);
  const merchantId = str(p["merchant_id"]);
  if (paymentId === null || mandateId === null || merchantId === null) throw new TypeError(`the refund_requested row for ${rec.key} is missing a field`);

  const refunder = refunderFor(route, rec.rail);
  if (refunder === null) throw new Error(`no executor that can refund on rail ${rec.rail}`);
  const amount = minorFromDb(rec.amountMinor);
  const currency = rec.currency === "USD" || rec.currency === "INR" ? rec.currency : null;
  if (currency === null) throw new TypeError(`refund record ${rec.key} has an unknown currency`);

  // Throws when the rail can't say, and the record stays pending.
  const raw = await refunder.refund({ payment_id: paymentId, amount_minor: amount, currency, idempotency_key: rec.key });
  if (raw.payment_id !== paymentId) throw new Error(`the rail answered about payment ${raw.payment_id}, not ${paymentId}`);
  const outcome = acceptRefund(raw, { amount_minor: amount, currency });
  const order = { key: rec.orderKey, orderId: rec.orderId, mandateId, merchantId };

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MANDATE_LOCK_NS}, hashtext(${mandateId}))`;
    const current = await tx.idempotencyRecord.findUnique({ where: { key: rec.key }, select: { status: true } });
    if (current?.status !== "pending") return false;
    if (outcome.status === "pending") {
      const already = await tx.ledgerEntry.count({ where: { eventType: "refund_outcome", payload: { path: ["refund_key"], equals: rec.key } } });
      if (already > 0) return false;
    }
    await writeRefundOutcome(tx, { traceId: rec.traceId, order, refundKey: rec.key, outcome, actor: "reconciler", reconciled: true, now });
    return outcome.status !== "pending";
  });
}
