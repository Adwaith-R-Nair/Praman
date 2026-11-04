import { prisma } from "@praman/db";
import { append } from "@praman/ledger";
import { currencyFromDb, isRail, minorFromDb, minorToJSON } from "@praman/shared";
import { acceptOutcome, outcomeFields, type ExecutorRouter } from "@praman/exec-core";
import { RECONCILE_MIN_AGE_MS } from "./run-intent.js";

/**
 * Resolves pending records left by a crash or an ambiguous failure.
 *
 * Refuses to touch a record younger than RECONCILE_MIN_AGE_MS: Razorpay's order
 * lookup lags creation by seconds, so an early reconcile would see nothing,
 * conclude no order exists, and create a duplicate — the exact double-charge
 * this whole structure exists to prevent. Waiting is the correct behaviour.
 *
 * Asks the rail named on the record, which is the one that was called. A record
 * whose rail has no executor here stays pending, because "I can't ask" is not
 * "it didn't happen".
 */
export async function reconcilePending(route: ExecutorRouter, now: Date): Promise<number> {
  const stale = await prisma.idempotencyRecord.findMany({
    where: { status: "pending", createdAt: { lt: new Date(now.getTime() - RECONCILE_MIN_AGE_MS) } },
  });

  let resolved = 0;
  for (const rec of stale) {
    try {
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

      const authorised = minorFromDb(amountMinor);
      const rawFound = await executor.findOrder({
        receipt,
        idempotency_key: rec.key,
        order_id: null,
        amount_minor: authorised,
        currency,
      });
      const found = rawFound === null ? null : acceptOutcome(rawFound, { amount_minor: authorised, currency });

      await prisma.$transaction(async (tx) => {
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
      });

      resolved += 1;
    } catch (err) {
      // One unresolvable record must not block the rest of the batch — that's
      // the whole point of a reconciler. It stays pending; the next run tries again.
      console.error(`reconcile: failed to resolve ${rec.key}: ${String(err)}`);
    }
  }
  return resolved;
}
