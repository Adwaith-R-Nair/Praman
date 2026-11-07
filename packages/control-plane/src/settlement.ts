import { prisma, type PrismaTx } from "@praman/db";
import { append, maybeCheckpoint } from "@praman/ledger";
import { acceptOutcome, outcomeFields, receiptFor, type AcceptedOutcome, type ExecOutcome, type SettlementEvent } from "@praman/exec-core";
import { minorFromDb, minorFromJSON, minorToJSON, type Minor } from "@praman/shared";
import { readOrderView, type OrderView } from "./order-view.js";
import { MANDATE_LOCK_NS } from "./run-intent.js";

export type SettlementResult = "applied" | "duplicate" | "unmatched";

interface MatchedOrder {
  readonly key: string;
  readonly traceId: string;
}

/**
 * The order a settlement is about, found by the order id on the ledger's created
 * rows for that rail. Unmatched when there is none, when two keys claim it, or
 * when the provider echoes an invoice id that isn't this order's receipt.
 */
async function matchOrder(event: SettlementEvent): Promise<MatchedOrder | string> {
  const rows = await prisma.$queryRaw<{ trace_id: string; key: string | null }[]>`
    SELECT trace_id, payload->>'idempotency_key' AS key FROM ledger_entry
    WHERE event_type = 'outcome'
      AND payload->>'order_id' = ${event.order_id}
      AND payload->>'rail' = ${event.rail}
      AND payload->>'status' IN ('created', 'mismatch')
    ORDER BY seq ASC
  `;
  const keys = [...new Set(rows.map((r) => r.key))];
  const first = rows[0];
  if (first === undefined) return "no order on the ledger has this id";
  if (keys.length !== 1 || first.key === null) return "the ledger has this order id under more than one key, or none";
  if (event.invoice_id !== null && event.invoice_id !== receiptFor(first.key)) return "the invoice id is not this order's receipt";
  return { key: first.key, traceId: first.trace_id };
}

/** Whether the ledger already has this event, or this news about this payment under another event id. */
async function alreadySettled(tx: PrismaTx, event: SettlementEvent): Promise<boolean> {
  const rows = await tx.$queryRaw<{ event_id: string | null; payment_id: string | null; status: string | null }[]>`
    SELECT payload->>'event_id' AS event_id, payload->>'payment_id' AS payment_id, payload->>'status' AS status
    FROM ledger_entry
    WHERE event_type = 'settlement'
      AND payload->>'order_id' = ${event.order_id}
      AND payload->>'rail' = ${event.rail}
  `;
  return rows.some((r) => r.event_id === event.event_id || (r.payment_id === event.payment_id && r.status === event.status));
}

/** The amount Praman authorised for this order: the capture record's, else the ledger's single held amount. */
function authorised(view: OrderView, recordAmount: bigint | null): Minor | null {
  if (recordAmount !== null) return minorFromDb(recordAmount);
  const [held, other] = view.heldAmounts;
  return held !== undefined && other === undefined ? minorFromJSON(held) : null;
}

/**
 * Records what a verified webhook says happened to a capture (D-45). Call it only
 * with an event whose delivery was verified, and parsed by the rail package.
 *
 * Always one `settlement` row per piece of news, deduplicated on the event id and
 * on the payment and status, under the mandate lock so two deliveries at once
 * can't both write. The settlement row moves nothing on its own (D-31).
 *
 * An outcome is appended as well when a completed capture isn't on the ledger yet:
 * a captured outcome, or a mismatch if the money differs. This covers a capture whose
 * call is still out, one whose answer was lost, and one on an order Praman has since
 * released. A pending capture record is resolved, and a T2 or a sweep that arrives
 * later sees it resolved and writes nothing. An order is captured once, so a completed
 * capture answers every attempt on it.
 *
 * A declined capture is a settlement row only (D-46). It names a capture id, never the
 * attempt it answers, and an order can be retried after a refusal (D-40). A late or
 * redelivered decline of an earlier attempt would otherwise close a retry whose capture
 * then succeeds, leaving money moved with a failed outcome. The pending record is left
 * to its own T2, or to the sweep, which sends that attempt again under its own key and
 * so gets PayPal's answer for that attempt. No money moved on a decline, so the hold
 * stays either way. The sweep stays as the backstop for any webhook that never arrives.
 */
export async function applySettlement(event: SettlementEvent, now: Date): Promise<SettlementResult> {
  const matched = await matchOrder(event);
  if (typeof matched === "string") {
    console.warn(`settlement: ${event.rail} event ${event.event_id} for order ${event.order_id} is unmatched: ${matched}`);
    return "unmatched";
  }
  const { key, traceId } = matched;
  const first = await prisma.$transaction((tx) => readOrderView(tx, key, event.order_id));
  if (first === null) {
    console.warn(`settlement: ${event.rail} event ${event.event_id} for order ${event.order_id} is unmatched: no ledger view`);
    return "unmatched";
  }

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MANDATE_LOCK_NS}, hashtext(${first.mandateId}))`;
    if (await alreadySettled(tx, event)) return "duplicate";

    // Again under the lock: a T2, a sweep or a release may have written meanwhile.
    const view = (await readOrderView(tx, key, event.order_id)) ?? first;
    const record = await tx.idempotencyRecord.findFirst({
      where: { kind: "capture", orderKey: key, orderId: event.order_id, status: "pending" },
      orderBy: { createdAt: "desc" },
    });
    const where = { mandate_id: view.mandateId, merchant_id: view.merchantId, idempotency_key: key, order_id: event.order_id };

    await append(tx, {
      traceId,
      ts: now,
      actor: "webhook",
      eventType: "settlement",
      payload: {
        ...where,
        rail: event.rail,
        event_id: event.event_id,
        event_type: event.event_type,
        status: event.status,
        payment_id: event.payment_id,
        amount_minor: minorToJSON(event.amount_minor),
        currency: event.currency,
      },
    });

    let outcome: AcceptedOutcome | null = null;
    const amount = authorised(view, record?.amountMinor ?? null);
    if (event.status === "captured" && view.captured === null) {
      if (amount === null) {
        console.warn(`settlement: order ${event.order_id} holds more than one amount, so the capture is recorded as a settlement only`);
      } else {
        const reported: ExecOutcome = {
          rail: event.rail,
          order_id: event.order_id,
          status: "captured",
          amount_minor: event.amount_minor,
          currency: event.currency,
          payment_id: event.payment_id,
          approve_url: null,
          failure_code: null,
        };
        outcome = acceptOutcome(reported, { amount_minor: amount, currency: view.currency });
      }
    }
    if (event.status === "declined" && view.captured !== null) {
      console.warn(`settlement: order ${event.order_id} is captured on the ledger, and ${event.rail} now reports a declined capture ${event.payment_id}`);
    }

    if (outcome !== null) {
      await append(tx, {
        traceId,
        ts: now,
        actor: "webhook",
        eventType: "outcome",
        payload: {
          ...outcomeFields(outcome),
          ...where,
          ...(record !== null ? { capture_key: record.key } : {}),
          settlement_event_id: event.event_id,
        },
      });
      if (record !== null) {
        await tx.idempotencyRecord.update({
          where: { key: record.key },
          data: {
            status: "succeeded",
            outcome: { order_id: outcome.order_id, status: outcome.status, payment_id: outcome.payment_id, failure_code: outcome.failure_code },
            updatedAt: now,
          },
        });
      }
    }
    await maybeCheckpoint(tx, now);
    return "applied";
  });
}
