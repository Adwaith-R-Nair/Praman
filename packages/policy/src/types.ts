import type { Paise, StepUpCode, DenyCode } from "@praman/shared";

/** What the agent proposes. Note: no price field. See D-01. */
export interface PurchaseIntent {
  readonly intent_id: string;
  readonly mandate_id: string;
  readonly merchant_id: string;
  readonly line_items: readonly LineItem[];
  readonly requested_at: string;      // ISO 8601
  readonly agent_rationale: string;   // audit only, never parsed
}

export interface LineItem {
  readonly sku: string;
  readonly qty: number;               // a count, not money
}

/** A mandate whose signature has ALREADY been verified upstream. */
export interface VerifiedMandate {
  readonly mandate_id: string;
  readonly subject_id: string;
  readonly scope: {
    readonly merchant_ids: readonly string[];
    readonly categories: readonly string[];
    readonly currency: "INR";
  };
  readonly limits: {
    readonly max_per_txn_paise: Paise;
    readonly max_total_paise: Paise;
    readonly max_txns_per_window: number;
    readonly window_seconds: number;
  };
  readonly step_up: {
    readonly threshold_paise: Paise;
  };
  readonly validity: {
    readonly not_before: Date;
    readonly not_after: Date;
  };
}

/** Derived by replaying the ledger. Never stored on the mandate. See D-03. */
export interface LedgerDerivedState {
  readonly spent_paise: Paise;
  readonly txn_timestamps: readonly Date[];   // successful txns, this mandate
  readonly revoked: boolean;
  readonly merchants_transacted: readonly string[];
  readonly seen_idempotency_keys: readonly string[];
}

/** Trusted, server-side. Prices come from here — never from the model. */
export interface CatalogSnapshot {
  readonly merchant_id: string;
  readonly items: ReadonlyMap<string, CatalogItem>;   // keyed by SKU
}

export interface CatalogItem {
  readonly sku: string;
  readonly category: string;
  readonly price_paise: Paise;
  readonly stock_qty: number;
}

export type Decision =
  | { readonly kind: "ALLOW"; readonly amount_paise: Paise; readonly reason_code: "OK"; readonly remaining_paise: Paise }
  | { readonly kind: "STEP_UP"; readonly amount_paise: Paise; readonly reason_code: StepUpCode }
  | { readonly kind: "DENY"; readonly reason_code: DenyCode; readonly detail: string };

/** What the agent is allowed to see. Never carries mandate limits. See D-08. */
export type AgentVisibleDecision =
  | { readonly kind: "ALLOW"; readonly amount_paise: Paise }
  | { readonly kind: "STEP_UP"; readonly amount_paise: Paise }
  | { readonly kind: "DENY"; readonly reason_code: DenyCode };

export interface EvaluateInput {
  readonly intent: PurchaseIntent;
  readonly mandate: VerifiedMandate;
  readonly state: LedgerDerivedState;
  readonly catalog: CatalogSnapshot;
  readonly now: Date;
  readonly idempotency_key: string;
}
