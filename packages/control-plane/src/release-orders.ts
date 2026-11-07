import { prisma, type PrismaTx } from "@praman/db";
import { append, maybeCheckpoint } from "@praman/ledger";
import type { ExecutorRouter } from "@praman/exec-core";
import { currencyFromDb, minorFromDb, type Rail } from "@praman/shared";
import { executorFor, ORDER_HOLD_TTL_MS } from "./capture-order.js";
import { readOrderView, type OrderView } from "./order-view.js";
import { MANDATE_LOCK_NS, parseCachedOutcome } from "./run-intent.js";

/**
 * Rails where a buyer approves at a checkout, so an order can sit unpaid. Razorpay
 * isn't one: its order counts as spend from creation (D-17) and is never released.
 */
export const CHECKOUT_RAILS: readonly Rail[] = ["paypal"];

/**
 * Whether the ledger lets this order go. Checked once to decide whether to ask the
 * rail, and again under the mandate lock before anything is written, since a capture
 * may have started in between.
 */
async function releasable(tx: PrismaTx, key: string, orderId: string, now: Date): Promise<OrderView | null> {
  const view = await readOrderView(tx, key, orderId);
  if (view === null || !view.created || view.captured !== null || view.released || view.mismatch !== null) return null;
  if (now.getTime() - view.recordedAt.getTime() < ORDER_HOLD_TTL_MS) return null;
  const pending = await tx.idempotencyRecord.count({ where: { kind: "capture", orderKey: key, orderId, status: "pending" } });
  return pending === 0 ? view : null;
}

/**
 * Gives back the budget of checkout orders nobody approved in time (D-30). An unapproved
 * PayPal order can't be cancelled by API (D-26), so "released" is Praman refusing to
 * capture it from now on. The order stays seen, so a repeat of its intent is refused.
 *
 * An order is released only when all of these hold: ten minutes have passed since
 * Praman recorded it, it has no capture, release or mismatch on the ledger, no capture
 * of it is pending, and its rail says it isn't captured. A definite capture failure
 * doesn't stop a release, because that capture took no money (D-40).
 *
 * Takes the same mandate lock as capture, so a capture and a release of one order can't
 * both go ahead. Returns how many orders were released.
 */
export async function releaseStaleOrders(route: ExecutorRouter, now: Date): Promise<number> {
  const records = await prisma.idempotencyRecord.findMany({
    where: { kind: "order", status: "succeeded", rail: { in: [...CHECKOUT_RAILS] } },
    orderBy: { createdAt: "asc" },
  });

  let released = 0;
  for (const rec of records) {
    try {
      const { orderId, status } = parseCachedOutcome(rec, rec.key);
      if (orderId === null || status !== "created" || rec.receipt === null || rec.amountMinor === null) continue;
      const receipt = rec.receipt;
      const amountMinor = rec.amountMinor;

      const candidate = await prisma.$transaction((tx) => releasable(tx, rec.key, orderId, now));
      if (candidate === null) continue;

      const executor = executorFor(route, rec.rail);
      if (executor === null) throw new Error(`no executor for rail ${rec.rail}`);

      // Outside any transaction. A throw or a null leaves the order held: "I can't
      // ask" and "the rail doesn't know it" aren't "it wasn't paid".
      const atRail = await executor.findOrder({ receipt, idempotency_key: rec.key, order_id: orderId, amount_minor: minorFromDb(amountMinor), currency: currencyFromDb(rec.currency) });
      if (atRail === null) throw new Error(`the rail has no order ${orderId}`);
      if (atRail.status === "captured") throw new Error(`order ${orderId} is captured at the rail with no capture on the ledger`);

      const done = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MANDATE_LOCK_NS}, hashtext(${candidate.mandateId}))`;
        const view = await releasable(tx, rec.key, orderId, now);
        if (view === null) return false;
        await append(tx, {
          traceId: rec.traceId,
          ts: now,
          actor: "praman",
          eventType: "outcome",
          payload: {
            mandate_id: view.mandateId,
            merchant_id: view.merchantId,
            rail: executor.rail,
            status: "released",
            order_id: orderId,
            idempotency_key: rec.key,
            currency: view.currency,
            detail: "not approved within 10 minutes; the hold is given back and the order will not be captured",
          },
        });
        await maybeCheckpoint(tx, now);
        return true;
      });
      if (done) released += 1;
    } catch (err) {
      // One order that can't be settled must not stop the rest. It stays held.
      console.error(`release: left ${rec.key} held: ${String(err)}`);
    }
  }
  return released;
}
