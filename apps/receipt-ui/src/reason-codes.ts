import type { ReasonCode } from "@praman/shared";

/**
 * "Refused: the cart's category isn't covered by this mandate" beats
 * CATEGORY_OUT_OF_SCOPE for a human reader. Shown together, plain language
 * first — never instead of the code, which stays visible for anyone who
 * needs to search or cite it.
 */
export const REASON_CODE_PLAIN: Record<ReasonCode, string> = {
  OK: "Allowed — within every limit this mandate sets.",
  STEP_UP_THRESHOLD: "This amount needs a human's approval before it can go through.",
  STEP_UP_FIRST_MERCHANT: "First purchase from this merchant under this mandate — needs a human's approval.",
  MANDATE_SIGNATURE_INVALID: "Refused — the mandate's signature didn't verify.",
  MANDATE_REVOKED: "Refused — this mandate has been revoked.",
  DENIAL_RATE_EXCEEDED: "Refused — too many denials recently; the mandate is locked pending review.",
  MANDATE_EXPIRED: "Refused — this mandate's validity period has ended.",
  MANDATE_NOT_YET_VALID: "Refused — this mandate isn't valid yet.",
  MANDATE_SUBJECT_MISMATCH: "Refused — this purchase doesn't belong to this mandate.",
  MANDATE_AMOUNT_EXCEEDED: "Refused — over this mandate's per-purchase limit.",
  MANDATE_BUDGET_EXHAUSTED: "Refused — over this mandate's total budget.",
  VELOCITY_EXCEEDED: "Refused — too many purchases in a short window.",
  MERCHANT_OUT_OF_SCOPE: "Refused — this merchant isn't on the mandate's allowed list.",
  CATEGORY_OUT_OF_SCOPE: "Refused — the cart's category isn't covered by this mandate.",
  SKU_UNKNOWN: "Refused — one of the items isn't in this merchant's catalog.",
  INSUFFICIENT_STOCK: "Refused — not enough stock for the quantity requested.",
  AMOUNT_INVALID: "Refused — the resolved amount isn't a valid purchase.",
  DUPLICATE_INTENT: "Refused — this exact purchase was already submitted.",
  AMOUNT_CHANGED_SINCE_APPROVAL: "Refused — the price changed after a human approved this purchase.",
};
