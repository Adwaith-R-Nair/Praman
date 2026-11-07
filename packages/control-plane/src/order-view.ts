import type { PrismaTx } from "@praman/db";
import { readAmount, readCurrency } from "@praman/ledger";
import type { Currency } from "@praman/shared";

/**
 * What the ledger says about one order: the rows on its key that name its order
 * id. The ledger, not the outbox record, is the evidence, so capture and release
 * decide from this and only use the record to find the order.
 */
export interface OrderView {
  readonly key: string;
  readonly orderId: string;
  readonly mandateId: string;
  readonly merchantId: string;
  /** When Praman first recorded the order, by its own clock. The release window starts here. */
  readonly recordedAt: Date;
  /** Every amount a created row holds. One value, unless two rows disagree. */
  readonly heldAmounts: readonly string[];
  readonly currency: Currency;
  /** Whether a created row exists, so an order really was made on this key. */
  readonly created: boolean;
  readonly captured: { readonly paymentId: string | null } | null;
  readonly released: boolean;
  /** The rail's failure code on a mismatch row (D-33). */
  readonly mismatch: { readonly failureCode: string | null } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Null when the ledger has no row for this order. A failed row is a capture that
 * took no money, or a create that made nothing, so it changes nothing here.
 */
export async function readOrderView(tx: PrismaTx, key: string, orderId: string): Promise<OrderView | null> {
  const rows = await tx.$queryRaw<{ seq: bigint; ts: Date; payload: unknown }[]>`
    SELECT seq, ts, payload FROM ledger_entry
    WHERE event_type = 'outcome'
      AND payload->>'idempotency_key' = ${key}
      AND payload->>'order_id' = ${orderId}
    ORDER BY seq ASC
  `;

  let mandateId: string | null = null;
  let merchantId: string | null = null;
  let recordedAt: Date | null = null;
  let currency: Currency | null = null;
  const held = new Set<string>();
  let created = false;
  let captured: OrderView["captured"] = null;
  let released = false;
  let mismatch: OrderView["mismatch"] = null;

  for (const row of rows) {
    if (!isRecord(row.payload)) continue;
    const p = row.payload;
    const status = p["status"];
    mandateId ??= str(p["mandate_id"]);
    merchantId ??= str(p["merchant_id"]);
    recordedAt ??= row.ts;

    if (status === "released") {
      released = true;
      continue;
    }
    if (status === "created" || status === "mismatch") {
      created = true;
      held.add(readAmount(p, row.seq));
      currency ??= readCurrency(p);
    }
    if (status === "captured") {
      captured ??= { paymentId: str(p["payment_id"]) };
      currency ??= readCurrency(p);
    }
    if (status === "mismatch") mismatch ??= { failureCode: str(p["failure_code"]) };
  }

  if (mandateId === null || merchantId === null || recordedAt === null || currency === null) return null;
  return { key, orderId, mandateId, merchantId, recordedAt, heldAmounts: [...held], currency, created, captured, released, mismatch };
}
