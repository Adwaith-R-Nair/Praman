export interface SeedEvent {
  readonly event: "outcome" | "decision";
  /** outcome events only. Defaults to "captured". */
  readonly status?: "captured" | "failed";
  /** decision events only. Defaults to "DENY". */
  readonly kind?: "ALLOW" | "STEP_UP" | "DENY";
  readonly amount_paise?: string;
  readonly merchant_id?: string;
  readonly reason_code?: string;
  readonly minutes_ago: number;
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
  readonly seed: readonly SeedEvent[];
  readonly intent: CaseIntent;
  readonly expected: ExpectedOutcome;
  readonly money_at_risk_paise: string;
  readonly notes: string;
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
