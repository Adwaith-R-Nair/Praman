import { createHash } from "node:crypto";
import { canonical } from "@praman/shared";
import type { PurchaseIntent } from "@praman/policy";

/**
 * Line items sorted by SKU before hashing. Cart identity must not depend on
 * item order — otherwise a reordered retry derives a different key and the
 * duplicate guard misses it, double-charging. Same fix as the sorted iteration
 * in evaluate().
 */
export function canonicalIntent(intent: PurchaseIntent): string {
  return canonical({
    intent_id: intent.intent_id,
    mandate_id: intent.mandate_id,
    merchant_id: intent.merchant_id,
    line_items: [...intent.line_items]
      .sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0))
      .map((i) => ({ sku: i.sku, qty: i.qty })),
  });
}

/** Derived, never supplied. See D-06. */
export function idempotencyKey(mandateId: string, intent: PurchaseIntent): string {
  return createHash("sha256").update(mandateId + "|" + canonicalIntent(intent), "utf8").digest("hex");
}

/** Razorpay's receipt field caps at 40 chars; 40 hex = 160 bits, ample. */
export const receiptFor = (key: string): string => key.slice(0, 40);
