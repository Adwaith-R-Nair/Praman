import type { ReasonCode } from "@praman/shared";
import type { BreakReason, EventType } from "@praman/ledger";

/** What each verifyChain() BreakReason means for someone who isn't the person who wrote it. */
export const BREAK_REASON_PLAIN: Record<BreakReason, string> = {
  SEQ_GAP: "An entry is missing from the chain — deleted, or never actually recorded.",
  PREV_MISMATCH: "This entry doesn't link to the one that comes before it.",
  PAYLOAD_HASH_MISMATCH: "This entry's contents changed after it was written.",
  ENTRY_HASH_MISMATCH: "This entry's own fields changed after it was written.",
  MERKLE_MISMATCH: "A checkpoint's summary doesn't match the entries it's supposed to cover.",
};

export const EVENT_TYPE_PLAIN: Record<EventType, string> = {
  intent: "Agent proposed a purchase",
  decision: "Policy engine decided",
  step_up_resolved: "Human reviewed the step-up",
  api_call: "Payment provider called",
  outcome: "Payment result recorded",
  mandate_revoked: "Mandate revoked",
  checkpoint: "Chain checkpoint",
  agent_transcript: "Agent's full transcript recorded",
  capture_decision: "Policy engine re-checked the mandate before capture",
  settlement: "Payment provider reported the final result",
  refund_requested: "A person asked for a refund, and the payment provider was called",
  refund_outcome: "Refund result recorded",
};

/**
 * What a `step_up_resolved` row is called on a trace the demo's test harness made. The
 * harness approves its own first purchase in code, so that row is never called a human
 * review (D-53). The trace page and the console's Event column both say this.
 */
export const HARNESS_APPROVAL_PLAIN = "Test harness approved the step-up. No person reviewed it";

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
  DENIAL_RATE_EXCEEDED: "Too many denials recently. The mandate is locked pending review.",
  MANDATE_EXPIRED: "This mandate's validity period has ended.",
  MANDATE_NOT_YET_VALID: "This mandate isn't valid yet.",
  MANDATE_SUBJECT_MISMATCH: "This purchase doesn't belong to this mandate.",
  MANDATE_AMOUNT_EXCEEDED: "This is over the mandate's per-purchase limit.",
  MANDATE_BUDGET_EXHAUSTED: "This is over the mandate's total budget.",
  VELOCITY_EXCEEDED: "Too many purchases in a short window.",
  MERCHANT_OUT_OF_SCOPE: "This merchant isn't on the mandate's allowed list, or Praman has no way to pay it.",
  CATEGORY_OUT_OF_SCOPE: "The cart's category isn't covered by this mandate.",
  SKU_UNKNOWN: "One of the items isn't in this merchant's catalog.",
  INSUFFICIENT_STOCK: "Not enough stock for the quantity requested.",
  AMOUNT_INVALID: "The resolved amount isn't a valid purchase.",
  DUPLICATE_INTENT: "This exact purchase was already submitted.",
  AMOUNT_CHANGED_SINCE_APPROVAL: "The price changed after a human approved this purchase.",
  CURRENCY_MISMATCH: "This purchase is in a different currency from this mandate. Nothing is ever converted.",
  ORDER_RELEASED: "This checkout wasn't approved in time, so its budget was given back. Nothing was charged.",
};
