import { prisma } from "@praman/db";
import { append } from "@praman/ledger";
import { currencyFromDb, isRail, minorFromDb, minorToJSON } from "@praman/shared";
import { acceptOutcome, outcomeFields, receiptFor, type AcceptedOutcome, type ExecutorRouter } from "@praman/exec-core";
import { executorFor, sendCapture } from "./capture-order.js";
import { readOrderView } from "./order-view.js";
import { MANDATE_LOCK_NS, RECONCILE_MIN_AGE_MS } from "./run-intent.js";

type PendingRecord = Awaited<ReturnType<typeof prisma.idempotencyRecord.findMany>>[number];

/**
 * A capture record is checked by reading its order by id. Repeating the create would
 * hand back the order as first created, and say nothing about the capture (D-38).
 *
 * Captured or refused at the rail: that is recorded, under the ORDER's key. Not captured
 * yet doesn't prove no money moved, because PayPal may still be completing the capture
 * (D-39), and a record closed as failed would let the release sweep free the hold. So
 * the same attempt is sent again under the same key (D-41). PayPal-Request-Id makes it
 * the same capture. A capture that never arrived is made now, under the decision T1
 * already recorded. One still being completed throws, and the record stays pending. A
 * definite refusal, such as ORDER_NOT_APPROVED, is recorded as failed and keeps the hold.
 *
 * The record is re-read under the mandate lock, so a late T2 and this can't both write.
 */
async function reconcileCapture(rec: PendingRecord, route: ExecutorRouter, now: Date): Promise<boolean> {
  if (rec.orderKey === null || rec.orderId === null) throw new TypeError(`capture record ${rec.key} names no order`);
  if (rec.amountMinor === null) throw new TypeError(`capture record ${rec.key} has no amount_minor`);
  const orderKey = rec.orderKey;
  const orderId = rec.orderId;
  const amount = minorFromDb(rec.amountMinor);
  const currency = currencyFromDb(rec.currency);
  const executor = executorFor(route, rec.rail);
  if (executor === null) throw new Error(`no executor for rail ${rec.rail}`);

  const view = await prisma.$transaction((tx) => readOrderView(tx, orderKey, orderId));
  if (view === null) throw new Error(`no ledger outcome for order ${orderId} on ${orderKey}`);

  const read = await executor.findOrder({ receipt: rec.receipt ?? receiptFor(orderKey), idempotency_key: orderKey, order_id: orderId, amount_minor: amount, currency });
  if (read !== null && read.order_id !== orderId) throw new Error(`the rail answered about order ${read.order_id}, not ${orderId}`);

  let outcome: AcceptedOutcome;
  if (read === null) {
    outcome = {
      rail: executor.rail,
      order_id: orderId,
      status: "failed",
      amount_minor: amount,
      currency,
      payment_id: null,
      approve_url: null,
      failure_code: "RECONCILE_ORDER_NOT_FOUND",
    };
  } else if (read.status === "captured" || read.status === "failed") {
    outcome = acceptOutcome(read, { amount_minor: amount, currency });
  } else {
    // Throws when the rail can't yet say, and the record stays pending.
    const sent = await sendCapture(executor, { orderKey, orderId, captureKey: rec.key, amount, currency });
    outcome = acceptOutcome(sent, { amount_minor: amount, currency });
  }

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MANDATE_LOCK_NS}, hashtext(${view.mandateId}))`;
    const current = await tx.idempotencyRecord.findUnique({ where: { key: rec.key }, select: { status: true } });
    if (current?.status !== "pending") return false;
    await append(tx, {
      traceId: rec.traceId,
      ts: now,
      actor: "reconciler",
      eventType: "outcome",
      payload: {
        ...outcomeFields(outcome),
        mandate_id: view.mandateId,
        merchant_id: view.merchantId,
        idempotency_key: orderKey,
        order_id: orderId,
        capture_key: rec.key,
        reconciled: true,
      },
    });
    await tx.idempotencyRecord.update({
      where: { key: rec.key },
      data: {
        status: outcome.status === "failed" ? "failed" : "succeeded",
        outcome: { order_id: orderId, status: outcome.status, payment_id: outcome.payment_id, failure_code: outcome.failure_code },
        updatedAt: now,
      },
    });
    return true;
  });
}

/**
 * Resolves pending records left by a crash or an ambiguous failure.
 *
 * Refuses to touch a record younger than RECONCILE_MIN_AGE_MS: Razorpay's order
 * lookup lags creation by seconds, so an early reconcile would see nothing,
 * conclude no order exists, and create a duplicate — the exact double-charge
 * this whole structure exists to prevent. Waiting is the correct behaviour.
 *
 * An order record is checked by repeating the create with its key (D-26). A capture
 * record is checked by reading its order by id, in reconcileCapture.
 *
 * Asks the rail named on the record, which is the one that was called. A record
 * whose rail has no executor here, or whose router hands back another rail, stays
 * pending, because "I can't ask" is not "it didn't happen".
 */
export async function reconcilePending(route: ExecutorRouter, now: Date): Promise<number> {
  const stale = await prisma.idempotencyRecord.findMany({
    where: { status: "pending", createdAt: { lt: new Date(now.getTime() - RECONCILE_MIN_AGE_MS) } },
  });

  let resolved = 0;
  for (const rec of stale) {
    try {
      if (rec.kind === "capture") {
        if (await reconcileCapture(rec, route, now)) resolved += 1;
        continue;
      }
      if (rec.kind !== "order") throw new TypeError(`record ${rec.key} has an unknown kind: ${rec.kind}`);
      if (rec.receipt === null) throw new TypeError(`record ${rec.key} has no receipt`);
      if (rec.amountMinor === null) throw new TypeError(`record ${rec.key} has no amount_minor`);
      const receipt = rec.receipt;
      const amountMinor = rec.amountMinor;

      // The pending record itself doesn't carry mandate_id/merchant_id — the
      // intent event written in T1 does, and it's already durable. Without
      // this, the outcome event below would have no mandate_id in its
      // payload, and deriveState (which filters on payload->>'mandate_id')
      // would never see it: a reconciled captured payment would silently
      // never count toward spend.
      //
      // Found by key, not by trace alone. A trace id comes from the intent id,
      // and two mandates can propose the same one, so a trace can hold two
      // attempts, and the first intent on it may not be this record's.
      const intentRow = await prisma.ledgerEntry.findFirst({
        where: { traceId: rec.traceId, eventType: "intent", payload: { path: ["idempotency_key"], equals: rec.key } },
        orderBy: { seq: "asc" },
      });
      if (intentRow === null) throw new Error(`no intent ledger entry found for ${rec.key} on trace ${rec.traceId}`);
      const intentPayload = intentRow.payload as Record<string, unknown>;
      const mandateId = intentPayload["mandate_id"];
      const merchantId = intentPayload["merchant_id"];
      if (typeof mandateId !== "string" || typeof merchantId !== "string") {
        throw new TypeError(`intent payload for trace ${rec.traceId} is missing mandate_id/merchant_id`);
      }

      // T1 wrote this next to the amount. An unknown value throws, and stays pending.
      const currency = currencyFromDb(rec.currency);

      if (!isRail(rec.rail)) throw new TypeError(`record ${rec.key} has an unknown rail: ${rec.rail}`);
      const executor = route(rec.rail);
      if (executor === null) throw new Error(`no executor for rail ${rec.rail}`);
      // routeAllTo answers every rail with one executor. Here that would be a
      // simulator saying "not found" about a real order, which writes a failed
      // outcome and frees the budget that order holds.
      if (executor.rail !== rec.rail) throw new Error(`record ${rec.key} is on rail ${rec.rail}, and rail ${executor.rail} can't answer for it`);

      const authorised = minorFromDb(amountMinor);
      const rawFound = await executor.findOrder({
        receipt,
        idempotency_key: rec.key,
        order_id: null,
        amount_minor: authorised,
        currency,
      });
      const found = rawFound === null ? null : acceptOutcome(rawFound, { amount_minor: authorised, currency });

      // Under the mandate lock, like T1 and T2, and only if the record is still
      // pending once the lock is held. A T2 that arrived late has already settled
      // it, and a second outcome would be a second answer to one call (D-42).
      const wrote = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MANDATE_LOCK_NS}, hashtext(${mandateId}))`;
        const current = await tx.idempotencyRecord.findUnique({ where: { key: rec.key }, select: { status: true } });
        if (current?.status !== "pending") return false;
        await append(tx, {
          traceId: rec.traceId,
          ts: now,
          actor: "reconciler",
          eventType: "outcome",
          payload: {
            mandate_id: mandateId,
            merchant_id: merchantId,
            // Found nothing means no order exists, so it holds nothing.
            ...(found !== null
              ? outcomeFields(found)
              : { rail: executor.rail, status: "failed", order_id: null, payment_id: null, failure_code: null, amount_minor: minorToJSON(authorised), currency }),
            idempotency_key: rec.key,
            reconciled: true,
          },
        });
        await tx.idempotencyRecord.update({
          where: { key: rec.key },
          data: {
            status: found && found.status !== "failed" ? "succeeded" : "failed",
            outcome: found ? { order_id: found.order_id, status: found.status, approve_url: found.approve_url } : {},
            updatedAt: now,
          },
        });
        return true;
      });

      if (wrote) resolved += 1;
    } catch (err) {
      // One unresolvable record must not block the rest of the batch — that's
      // the whole point of a reconciler. It stays pending; the next run tries again.
      console.error(`reconcile: failed to resolve ${rec.key}: ${String(err)}`);
    }
  }
  return resolved;
}
