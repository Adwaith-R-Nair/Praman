import type { ReasonCode } from "@praman/shared";
import type { EventType } from "@praman/ledger";

export const EVENT_TYPE_PLAIN: Record<EventType, string> = {
  intent: "Agent proposed a purchase",
  decision: "Policy engine decided",
  step_up_resolved: "Human reviewed the step-up",
  api_call: "Payment provider called",
  outcome: "Payment result recorded",
  mandate_revoked: "Mandate revoked",
  checkpoint: "Chain checkpoint",
  agent_transcript: "Agent's full transcript recorded",
};

/**
 * "The cart's category isn't covered by this mandate" beats
 * CATEGORY_OUT_OF_SCOPE for a human reader. Shown together, plain language
 * first — never instead of the code, which stays visible for anyone who
 * needs to search or cite it.
 *
 * No "Allowed —"/"Refused —" prefixes here: the hero above already states
 * the outcome, in color, as the page's own headline. Repeating it in the
 * very next line would be the page contradicting its own hierarchy — this
 * text's job is to add the reason, not restate the verdict.
 */
export const REASON_CODE_PLAIN: Record<ReasonCode, string> = {
  OK: "Every limit this mandate sets is satisfied.",
  STEP_UP_THRESHOLD: "This amount is at or above the threshold that needs a human's approval.",
  STEP_UP_FIRST_MERCHANT: "This is the first purchase from this merchant under this mandate.",
  MANDATE_SIGNATURE_INVALID: "The mandate's signature didn't verify.",
  MANDATE_REVOKED: "This mandate has been revoked.",
  DENIAL_RATE_EXCEEDED: "Too many denials recently — the mandate is locked pending review.",
  MANDATE_EXPIRED: "This mandate's validity period has ended.",
  MANDATE_NOT_YET_VALID: "This mandate isn't valid yet.",
  MANDATE_SUBJECT_MISMATCH: "This purchase doesn't belong to this mandate.",
  MANDATE_AMOUNT_EXCEEDED: "This is over the mandate's per-purchase limit.",
  MANDATE_BUDGET_EXHAUSTED: "This is over the mandate's total budget.",
  VELOCITY_EXCEEDED: "Too many purchases in a short window.",
  MERCHANT_OUT_OF_SCOPE: "This merchant isn't on the mandate's allowed list.",
  CATEGORY_OUT_OF_SCOPE: "The cart's category isn't covered by this mandate.",
  SKU_UNKNOWN: "One of the items isn't in this merchant's catalog.",
  INSUFFICIENT_STOCK: "Not enough stock for the quantity requested.",
  AMOUNT_INVALID: "The resolved amount isn't a valid purchase.",
  DUPLICATE_INTENT: "This exact purchase was already submitted.",
  AMOUNT_CHANGED_SINCE_APPROVAL: "The price changed after a human approved this purchase.",
};
