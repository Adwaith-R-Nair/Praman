# Praman — Mandate, Decision & Ledger Specification

This is the trust core. Everything else in the repo is plumbing around these three data structures.

---

## 1. Mandate

A mandate is a signed grant of bounded spend authority from a human issuer to an agent. It is the agentic equivalent of the consent-plus-limit pattern used in UPI Circle delegation and the Razorpay–NPCI agentic UPI pilot.

```jsonc
{
  "mandate_id": "mnd_01J8XK2P9Q",
  "version": 1,
  "issuer_id": "usr_adwaith",              // the human
  "subject_id": "agt_lunchbuyer",          // the agent
  "scope": {
    "merchant_ids": ["MERCH_001"],         // closed allowlist, never wildcard
    "categories": ["food", "beverage"],    // closed allowlist
    "currency": "INR"
  },
  "limits": {
    "max_per_txn_paise": 80000,            // ₹800.00
    "max_total_paise": 500000,             // ₹5,000.00
    "max_txns_per_window": 5,
    "window_seconds": 3600,
    "max_denials_per_window": 5             // closes D-20's probe oracle
  },
  "step_up": {
    "threshold_paise": 50000               // above ₹500 → human approval
  },
  "validity": {
    "not_before": "2026-08-28T00:00:00Z",
    "not_after":  "2026-08-29T00:00:00Z"
  },
  "nonce": "b0f3c9d2a1e84f77",
  "revoked": false,
  "signature": {
    "alg": "Ed25519",
    "key_id": "usr_adwaith_k1",
    "value": "base64url(...)"              // over canonical_json(mandate minus signature)
  }
}
```

**Rules**

- `merchant_ids` and `categories` are closed allowlists. There is no wildcard. Absence of a value denies.
- Signature covers the canonical JSON of every field except `signature` itself. Canonicalisation: sorted keys, no whitespace, UTF-8, integers only (`packages/shared/canonical.ts`).
- Spend consumed is **not** stored on the mandate. It is derived by replaying the ledger, so a tampered mandate row can't grant extra budget.
- Revocation is an append to the ledger (`event_type: "mandate_revoked"`), not a field flip.

---

## 2. PurchaseIntent

Emitted by the agent as a tool call. Structured only — never prose.

```jsonc
{
  "intent_id": "int_01J8XK4M2A",
  "mandate_id": "mnd_01J8XK2P9Q",
  "merchant_id": "MERCH_001",
  "line_items": [
    { "sku": "SKU_MEALS_042", "qty": 2 }   // NOTE: no price field — by design
  ],
  "requested_at": "2026-08-28T12:04:11Z",
  "agent_rationale": "User asked for lunch under ₹400; this is the cheapest veg thali in stock."
}
```

**Critical:** the intent carries no amount. Prices are resolved server-side from the catalog at evaluation time. This single design choice kills an entire class of injection attack — a merchant page that says "this item costs ₹1" cannot influence the charged amount, because the model never touches the number.

`agent_rationale` is stored for audit and **never parsed**. It is display-only.

---

## 3. The decision function

This is the file you write by hand. Signature:

```ts
export function evaluate(
  intent: PurchaseIntent,
  mandate: VerifiedMandate,
  state: LedgerDerivedState,   // { spent_paise, txn_timestamps[], revoked }
  catalog: CatalogSnapshot,    // trusted, server-side
  now: Date
): Decision;

export type Decision =
  | { kind: "ALLOW";   amount_paise: bigint; reason_code: "OK"; remaining_paise: bigint }
  | { kind: "STEP_UP"; amount_paise: bigint; reason_code: StepUpCode }
  | { kind: "DENY";    reason_code: DenyCode; detail: string };
```

`approval_id` is not part of `Decision` — `evaluate()` is pure and knows nothing about approvals. It's assigned by `run-intent.ts` after a `STEP_UP`, and lives on `RunResult`, one level up from the agent-visible decision (D-24).

**Evaluation order matters and must be documented.** Cheapest and most fatal checks first:

1. mandate signature valid → else `MANDATE_SIGNATURE_INVALID`
2. mandate not revoked → else `MANDATE_REVOKED`
2b. denials in `window_seconds` < `max_denials_per_window` → else `DENIAL_RATE_EXCEEDED` *(closes D-20's probe oracle — a locked mandate must cost nothing to reject, so this runs early, but after revocation so revocation still wins)*
3. `now` within validity window → else `MANDATE_EXPIRED` / `MANDATE_NOT_YET_VALID`
4. `intent.mandate_id === mandate.mandate_id` → else `MANDATE_SUBJECT_MISMATCH`
5. merchant in scope → else `MERCHANT_OUT_OF_SCOPE`
6. every SKU exists in catalog → else `SKU_UNKNOWN` *(catches hallucinated SKUs)*
7. every SKU's category in scope → else `CATEGORY_OUT_OF_SCOPE`
8. every SKU in stock for qty → else `INSUFFICIENT_STOCK`
9. **resolve amount from catalog** — `amount_paise = Σ(catalog[sku].price_paise × qty)`
10. `amount_paise > 0` and within sane bounds → else `AMOUNT_INVALID`
11. `amount_paise ≤ max_per_txn_paise` → else `MANDATE_AMOUNT_EXCEEDED`
12. `state.spent_paise + amount_paise ≤ max_total_paise` → else `MANDATE_BUDGET_EXHAUSTED`
13. txns in `window_seconds` < `max_txns_per_window` → else `VELOCITY_EXCEEDED`
14. `amount_paise ≥ step_up.threshold_paise` → `STEP_UP` with `STEP_UP_THRESHOLD`
15. otherwise `ALLOW`

**Properties this function must have, and that your tests must assert:**

- Pure. No I/O, no clock read (`now` is injected), no randomness.
- Total. Every input produces a `Decision`; there is no throw path.
- Deterministic. Same inputs → byte-identical output. The eval harness depends on this.
- Monotone in spend: once `DENY` for budget, no later identical intent is `ALLOW` without a new mandate.

Write this function first, on paper, before any other code in the repo.

---

## 4. Reason codes (closed enum)

| Code | Kind | Meaning |
|---|---|---|
| `OK` | ALLOW | within all bounds |
| `STEP_UP_THRESHOLD` | STEP_UP | amount at or above human-approval threshold |
| `STEP_UP_FIRST_MERCHANT` | STEP_UP | first ever transaction at this merchant under this mandate |
| `MANDATE_SIGNATURE_INVALID` | DENY | signature failed verification |
| `MANDATE_REVOKED` | DENY | revocation present in ledger |
| `DENIAL_RATE_EXCEEDED` | DENY | too many denials in window — mandate locked pending human review (D-20) |
| `MANDATE_EXPIRED` | DENY | past `not_after` |
| `MANDATE_NOT_YET_VALID` | DENY | before `not_before` |
| `MANDATE_SUBJECT_MISMATCH` | DENY | intent references a different mandate/agent |
| `MANDATE_AMOUNT_EXCEEDED` | DENY | over per-transaction cap |
| `MANDATE_BUDGET_EXHAUSTED` | DENY | over cumulative cap |
| `VELOCITY_EXCEEDED` | DENY | too many transactions in window |
| `MERCHANT_OUT_OF_SCOPE` | DENY | merchant not in allowlist |
| `CATEGORY_OUT_OF_SCOPE` | DENY | SKU category not in allowlist |
| `SKU_UNKNOWN` | DENY | SKU not in catalog (hallucinated or stale) |
| `INSUFFICIENT_STOCK` | DENY | requested qty unavailable |
| `AMOUNT_INVALID` | DENY | non-positive or absurd resolved amount |
| `DUPLICATE_INTENT` | DENY | idempotency key already resolved |
| `AMOUNT_CHANGED_SINCE_APPROVAL` | DENY | catalog price moved between step-up and approval; the human approved a different rupee figure (D-24) |

Every code must appear in at least one eval fixture. A code with no fixture is untested surface. `AMOUNT_CHANGED_SINCE_APPROVAL` is a known gap here — the Layer 1 eval corpus tests `evaluate()` directly and has no seeding path for an approval/resolution cycle yet.

### 4b. Resolving a step-up (D-24)

A `STEP_UP` persists a pending `Approval` row (`run-intent.ts`) rather than executing anything. `resolveApproval()` (`packages/control-plane/src/resolve-approval.ts`) is the only way to move it forward, and approval satisfies **only** the step-up gate — nothing else:

- **Reject or expire** (15 minutes, `APPROVAL_TTL_MS`) → the approval is marked `rejected`/`expired`, a `step_up_resolved` ledger event records it, nothing executes.
- **Approve** → `evaluate()` runs again, fresh, against the mandate and ledger state *as they are now*, not as they were at step-up time. Revocation, expiry, budget and velocity are all re-checked. A `DENY` here refuses the approval outright (`REFUSED`), even though a human already said yes — approval cannot revive a mandate that died in the meantime.
- **Amount binding** — the human approved a specific rupee figure. If the catalog moved between step-up and approval, the re-evaluated amount won't match what was approved, and the approval is refused with `AMOUNT_CHANGED_SINCE_APPROVAL` rather than silently executing a different amount than what was shown.
- **Idempotent** — approving twice returns the same cached order the second time; exactly one Razorpay call ever happens per approval.

The rejected alternative was executing the stored intent directly on approval, without re-evaluating. That's a bypass: park a `STEP_UP`, wait for the mandate to expire or be revoked, then approve, and money moves under dead authority.

---

## 5. Ledger record

```jsonc
{
  "seq": 1042,
  "trace_id": "trc_01J8XK4M2A",
  "ts": "2026-08-28T12:04:11.882Z",
  "actor": "agt_lunchbuyer",
  "event_type": "decision",   // intent | decision | api_call | outcome | step_up_resolved | mandate_revoked
  "payload": { /* event-specific, canonicalised */ },
  "payload_hash": "sha256:...",
  "prev_hash": "sha256:...",
  "entry_hash": "sha256:..."  // sha256(prev_hash || seq || ts || actor || event_type || payload_hash)
}
```

- `seq` is a Postgres identity column; a gap means tampering.
- `entry_hash` chains to `prev_hash`. Genesis entry uses 64 zeros.
- Every 100 entries (or hourly), compute a Merkle root over `entry_hash` values and append a `checkpoint` entry containing it. The checkpoint is what you'd anchor externally in production — say this in the pitch, and be clear you didn't anchor it in the demo.
- Immutability enforced in migration:

```sql
CREATE RULE ledger_no_update AS ON UPDATE TO ledger_entry DO INSTEAD NOTHING;
CREATE RULE ledger_no_delete AS ON DELETE TO ledger_entry DO INSTEAD NOTHING;
```

- `pnpm verify-ledger` walks the chain, recomputes every hash, and exits non-zero on the first mismatch. Demo this, then tamper a row via a superuser connection and demo it failing.

### The trace

A `trace_id` groups the full lifecycle of one intent: `intent → decision → [step_up_resolved] → api_call → outcome`. The receipt page at `/r/:trace_id` renders these in order, including the agent's verbatim tool call and the reason code. That page is the artefact a dispute officer would read — it's the thing that makes agent spending *disputable*, and it's what nobody else in the applicant pool will have built.