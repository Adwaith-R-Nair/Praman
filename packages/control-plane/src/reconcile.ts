import { prisma } from "@praman/db";
import { append } from "@praman/ledger";
import { paiseFromDb, paiseToJSON } from "@praman/shared";
import type { Executor } from "@praman/razorpay-exec";
import { RECONCILE_MIN_AGE_MS } from "./run-intent.js";

/**
 * Resolves pending records left by a crash or an ambiguous failure.
 *
 * Refuses to touch a record younger than RECONCILE_MIN_AGE_MS: Razorpay's order
 * lookup lags creation by seconds, so an early reconcile would see nothing,
 * conclude no order exists, and create a duplicate — the exact double-charge
 * this whole structure exists to prevent. Waiting is the correct behaviour.
 */
export async function reconcilePending(executor: Executor, now: Date): Promise<number> {
  const stale = await prisma.idempotencyRecord.findMany({
    where: { status: "pending", createdAt: { lt: new Date(now.getTime() - RECONCILE_MIN_AGE_MS) } },
  });

  let resolved = 0;
  for (const rec of stale) {
    try {
      if (rec.receipt === null) throw new TypeError(`record ${rec.key} has no receipt`);
      if (rec.amountPaise === null) throw new TypeError(`record ${rec.key} has no amount_paise`);
      const receipt = rec.receipt;
      const amountPaise = rec.amountPaise;

      // The pending record itself doesn't carry mandate_id/merchant_id — the
      // intent event written in T1 does, and it's already durable. Without
      // this, the outcome event below would have no mandate_id in its
      // payload, and deriveState (which filters on payload->>'mandate_id')
      // would never see it: a reconciled captured payment would silently
      // never count toward spend.
      const intentRow = await prisma.ledgerEntry.findFirst({
        where: { traceId: rec.traceId, eventType: "intent" },
        orderBy: { seq: "asc" },
      });
      if (intentRow === null) throw new Error(`no intent ledger entry found for trace ${rec.traceId}`);
      const intentPayload = intentRow.payload as Record<string, unknown>;
      const mandateId = intentPayload["mandate_id"];
      const merchantId = intentPayload["merchant_id"];
      if (typeof mandateId !== "string" || typeof merchantId !== "string") {
        throw new TypeError(`intent payload for trace ${rec.traceId} is missing mandate_id/merchant_id`);
      }

      const found = await executor.findByReceipt(receipt);

      await prisma.$transaction(async (tx) => {
        await append(tx, {
          traceId: rec.traceId,
          ts: now,
          actor: "reconciler",
          eventType: "outcome",
          payload: {
            mandate_id: mandateId,
            merchant_id: merchantId,
            status: found ? found.status : "failed",
            order_id: found?.order_id ?? null,
            payment_id: found?.payment_id ?? null,
            amount_paise: paiseToJSON(paiseFromDb(amountPaise)),
            idempotency_key: rec.key,
            reconciled: true,
          },
        });
        await tx.idempotencyRecord.update({
          where: { key: rec.key },
          data: {
            status: found && found.status !== "failed" ? "succeeded" : "failed",
            outcome: found ? { order_id: found.order_id, status: found.status } : {},
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
