import type { Paise } from "./money.js";

/** Derived by replaying the ledger. Never stored on the mandate. See D-03. */
export interface LedgerDerivedState {
  readonly spent_paise: Paise;
  readonly txn_timestamps: readonly Date[];   // successful txns, this mandate
  readonly revoked: boolean;
  readonly merchants_transacted: ReadonlySet<string>;
  readonly seen_idempotency_keys: ReadonlySet<string>;
  /**
   * DENY outcomes, this mandate. Not yet read by evaluate() — denials cost
   * nothing today, which makes the ALLOW/DENY boundary a free oracle for a
   * probing agent. A future denial-rate cap reads this field to close that
   * gap. See D-20.
   */
  readonly denied_attempts: readonly Date[];
}
