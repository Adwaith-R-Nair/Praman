import type { DenyCode } from "@praman/shared";

/**
 * What a refusal means, for the agent and the person reading its reply. Each line
 * says what happened and what to do next. None of them states a limit: the
 * agent learns that a purchase was over the per-purchase limit, never the
 * limit itself (D-08). A Record over DenyCode, so a new reason code doesn't
 * compile until it has words here.
 */
export const DENY_PLAIN: Record<DenyCode, string> = {
  MANDATE_SIGNATURE_INVALID: "The mandate this gateway holds didn't verify. Nothing can be bought until the owner issues a new one.",
  MANDATE_REVOKED: "The owner revoked this mandate. Stop buying and tell the person.",
  DENIAL_RATE_EXCEEDED: "Too many refusals in a short time, so the mandate is locked for now. Stop and tell the person.",
  MANDATE_EXPIRED: "The mandate has expired. The owner has to issue a new one.",
  MANDATE_NOT_YET_VALID: "The mandate isn't valid yet. Try again after its start time.",
  MANDATE_SUBJECT_MISMATCH: "This purchase doesn't belong to the mandate this gateway holds.",
  MANDATE_AMOUNT_EXCEEDED: "This costs more than one purchase may cost under the mandate. Pick something cheaper or a smaller quantity.",
  MANDATE_BUDGET_EXHAUSTED: "This would go over the mandate's total budget. Only cheaper purchases, if any, can still go through.",
  VELOCITY_EXCEEDED: "Too many purchases in a short time. Wait before trying again.",
  MERCHANT_OUT_OF_SCOPE: "This merchant isn't covered by the mandate, or Praman has no way to pay it. Pick another merchant.",
  CATEGORY_OUT_OF_SCOPE: "The mandate doesn't cover this product's category. Don't retry it. Pick something else or ask the person.",
  SKU_UNKNOWN: "That SKU isn't in this merchant's catalog. Use search_products to find a real one.",
  INSUFFICIENT_STOCK: "Not enough stock for that quantity. Try a smaller quantity.",
  AMOUNT_INVALID: "The purchase came to an amount that can't be paid, for example a quantity of zero.",
  DUPLICATE_INTENT: "This exact purchase was already submitted. Use get_receipt on the earlier trace instead of proposing it again.",
  AMOUNT_CHANGED_SINCE_APPROVAL: "The price changed after the person approved it, so the approval no longer applies. Propose it again at the new price.",
  CURRENCY_MISMATCH: "This product is priced in a different currency from the mandate. Nothing is ever converted.",
  ORDER_RELEASED: "The buyer didn't pay at PayPal within 10 minutes, so the order was released and its budget given back. Nothing was charged.",
};
