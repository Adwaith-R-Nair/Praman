import type { Minor } from "./money.js";

/** Derived by replaying the ledger. Never stored on the mandate. See D-03. */
export interface LedgerDerivedState {
  readonly spent_minor: Minor;
  readonly txn_timestamps: readonly Date[];   // one per order, this mandate, released ones included
  readonly revoked: boolean;
  readonly merchants_transacted: ReadonlySet<string>;
  readonly seen_idempotency_keys: ReadonlySet<string>;
  /** Orders whose hold was given back. Refused at capture, and still in seen_idempotency_keys. */
  readonly released_keys: ReadonlySet<string>;
  /**
   * DENY outcomes, this mandate. Not yet read by evaluate() — denials cost
   * nothing today, which makes the ALLOW/DENY boundary a free oracle for a
   * probing agent. A future denial-rate cap reads this field to close that
   * gap. See D-20.
   */
  readonly denied_attempts: readonly Date[];
}
