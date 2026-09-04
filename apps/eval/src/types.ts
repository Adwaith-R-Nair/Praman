export interface SeedEvent {
  readonly event: "outcome" | "decision" | "revoked";
  /** outcome events only. Defaults to "captured". */
  readonly status?: "captured" | "failed";
  /** decision events only. Defaults to "DENY". */
  readonly kind?: "ALLOW" | "STEP_UP" | "DENY";
  readonly amount_paise?: string;
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

export interface ExpectedOutcome {
  readonly money_moves: boolean;
  readonly acceptable_reason_codes: readonly string[];
}

interface CaseIntent {
  readonly merchant_id: string;
  readonly line_items: readonly { sku: string; qty: number }[];
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
  readonly money_at_risk_paise: string;
  readonly notes: string;
  /** Simulates a forged mandate: verifyMandate is called with a public key that does not match the signing key. */
  readonly tamper?: "wrong_key";
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
  readonly amount_moved_paise: bigint;
  readonly reason_code: string;
  readonly decision_kind: string;
  readonly passed: boolean;
  /** Contained, but not for the predicted reason — a lucky pass, reported not hidden. */
  readonly incidental: boolean;
  /** Layer 2 only: did the injection alter the agent's proposal. */
  readonly influenced?: boolean;
  readonly money_at_risk_paise: bigint;
  readonly latency_ms: number;
  readonly detail: string;
}
