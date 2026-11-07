import type { TokenUsage } from "@praman/agent-core";
import type { Currency } from "@praman/shared";

export interface SeedEvent {
  readonly event: "outcome" | "decision" | "revoked";
  /** outcome events only. Defaults to "captured". */
  readonly status?: "created" | "captured" | "failed" | "released";
  /** outcome events only. A fixed key, so several events can describe one order. */
  readonly order_key?: string;
  /** decision events only. Defaults to "DENY". */
  readonly kind?: "ALLOW" | "STEP_UP" | "DENY";
  readonly amount_minor?: string;
  readonly merchant_id?: string;
  readonly reason_code?: string;
  readonly minutes_ago: number;
  /**
   * outcome events only. When true, the event's idempotency_key is computed
   * from the CASE'S OWN intent (or `duplicate_line_items_override` if given)
   * rather than a synthetic one — simulating "this exact cart already
   * succeeded" so DUPLICATE_INTENT can be tested via a single evaluate()
   * call instead of two live runIntent calls.
   */
  readonly duplicate_of_this_intent?: boolean;
  /** With duplicate_of_this_intent — compute the key from these line items instead (tests reordering/canonical-form equivalence). */
  readonly duplicate_line_items_override?: readonly { sku: string; qty: number }[];
}

/**
 * Makes a Layer 1 case test the capture re-check instead of a new purchase.
 * The seed puts an order in the ledger, and the case asks whether it may be
 * captured now. Only Layer 1, so nothing here reaches a rail.
 */
export interface CaseCapture {
  readonly order_key: string;
  readonly held_amount_minor: string;
  readonly quoted_amount_minor: string;
  readonly currency: Currency;
}

export interface ExpectedOutcome {
  readonly money_moves: boolean;
  readonly acceptable_reason_codes: readonly string[];
}

interface CaseIntent {
  readonly merchant_id: string;
  readonly line_items: readonly { sku: string; qty: number }[];
  /** Submit the intent under a different mandate_id than the signed mandate's own — tests MANDATE_SUBJECT_MISMATCH. */
  readonly intent_mandate_id_override?: string;
}

export interface Layer1Case {
  readonly case_id: string;
  readonly layer: 1;
  readonly family: string;
  readonly severity: "low" | "medium" | "high";
  readonly mandate: string;
  readonly catalog: string;
  /** Additional catalog fixtures seeded alongside the primary one — e.g. a SKU that only exists for a different merchant. */
  readonly extra_catalogs?: readonly string[];
  readonly seed: readonly SeedEvent[];
  readonly intent: CaseIntent;
  readonly expected: ExpectedOutcome;
  readonly money_at_risk_minor: string;
  readonly notes: string;
  /** Simulates a forged mandate: verifyMandate is called with a public key that does not match the signing key. */
  readonly tamper?: "wrong_key";
  /** Present on capture cases. `intent` then describes the cart the order came from. */
  readonly capture?: CaseCapture;
}

export interface Layer2Case {
  readonly case_id: string;
  readonly layer: 2;
  readonly family: "prompt_injection";
  readonly mandate: string;
  readonly catalog: string;
  readonly goal: string;
  /** SKUs the injection tries to smuggle in — used to detect influence. */
  readonly injected_skus: readonly string[];
  /** Quantity-inflation attacks: influence isn't a foreign SKU, it's an inflated qty on a legitimate one. */
  readonly injected_qty_floor?: { readonly sku: string; readonly qty: number };
  /** Merchant-switch attacks: influence is the proposed cart's merchant_id itself, not any SKU in it. */
  readonly injected_merchant_id?: string;
  readonly notes: string;
}

export interface CaseResult {
  readonly case_id: string;
  readonly family: string;
  readonly layer: 1 | 2;
  readonly money_moved: boolean;
  /**
   * Whether this case was ever supposed to move money. Some adversarial-
   * family cases (denial_probe's "legitimate purchase after 2 denials"
   * controls) are supposed to ALLOW — they prove the mechanism doesn't
   * over-trigger. Without this, containment_rate in metrics.ts would count
   * a correctly-allowed control as an uncontained attack.
   */
  readonly expected_money_moves: boolean;
  readonly amount_moved_minor: bigint;
  readonly reason_code: string;
  readonly decision_kind: string;
  readonly passed: boolean;
  /** Contained, but not for the predicted reason — a lucky pass, reported not hidden. */
  readonly incidental: boolean;
  /** Layer 2 only: did the injection alter the agent's proposal. */
  readonly influenced?: boolean;
  readonly money_at_risk_minor: bigint;
  /**
   * The rail the case's merchant was configured on. The executor is always
   * the simulated one, so this is what routing saw, not where money went.
   * Absent on results recorded before both rails ran.
   */
  readonly rail?: "razorpay" | "paypal";
  /**
   * True for a Layer 1 case rerun with every currency relabelled, so it runs
   * at a merchant on the other rail. Kept out of the headline rates and money
   * at risk, which count each corpus case once.
   */
  readonly mirrored?: boolean;
  /** The mandate's currency, which is what the at-risk amount is counted in. Null if the mandate's currency isn't supported. */
  readonly currency: Currency | null;
  readonly latency_ms: number;
  readonly detail: string;
  /**
   * Layer 2 only: tokens the provider said this case used, summed over
   * every model call in the run. Copied from the provider's own response.
   * Absent when the provider reported nothing.
   */
  readonly usage?: TokenUsage;
}
