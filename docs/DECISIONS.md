# Praman — Decision Records

Each entry: the decision, what it rules out, and the alternative rejected. This file exists because a panel will ask "why" about roughly ten things, and the difference between a strong candidate and a weak one is having thought about it *before* being asked.

Format: **D-nn · Decision · Status**

---

### D-01 · The intent carries no price · Accepted

The `PurchaseIntent` emitted by the agent contains `sku` and `qty` only. Amount is resolved server-side from the catalog after validation.

**Rejected:** letting the agent propose an amount and validating it against the catalog. That still puts an attacker-influenced number in the money path, and validation has bugs; absence does not.

**Consequence:** an entire family of injection attacks becomes structurally impossible rather than defended against. This is the single most important decision in the project.

---

### D-02 · No LLM in the authorisation path · Accepted

`evaluate()` is a pure function. No model call, direct or indirect.

**Rejected:** an "LLM judge" reviewing the agent's proposal. A non-deterministic reviewer of a non-deterministic actor gives you two things to debug and zero guarantees. You also cannot write a regression test against it.

**Consequence:** decisions are reproducible, which is what makes the eval harness meaningful.

---

### D-03 · Spend derived from the ledger, not stored on the mandate · Accepted

There is no `spent_paise` column. `deriveState()` replays ledger entries.

**Rejected:** a counter column with careful transactional updates. Correct until someone with DB access edits it, at which point the budget is a lie and nothing detects it.

**Trade-off accepted:** replay cost grows with history. Mitigated by checkpoints; at demo scale it's irrelevant. Say this out loud rather than pretending there's no cost.

---

### D-04 · Postgres, not MongoDB · Accepted

**Rejected:** MongoDB, despite prior experience with it (Honora).

Reasons: append-only immutability is enforceable with DB rules; `GENERATED ALWAYS AS IDENTITY` gives a sequence the application cannot supply, so gaps are evidence; the money path needs real transactions spanning several tables; `CHECK` constraints on `price_paise > 0` catch bad data at the boundary.

Being able to say "I used the thing I knew less well because it was correct" is a stronger signal than familiarity.

---

### D-05 · Per-mandate advisory lock, not SERIALIZABLE isolation · Accepted

`pg_advisory_xact_lock(hashtext(mandate_id))` at the top of the transaction.

**Rejected:** `SERIALIZABLE`, which aborts one transaction on conflict and demands retry logic in the money path — the last place you want automatic retries. The advisory lock makes the second caller wait and then observe committed state, producing a deterministic `DUPLICATE_INTENT` instead of a serialisation error.

**Trade-off:** per-mandate serialisation caps throughput per mandate. Acceptable — a single user's agent making concurrent purchases is not a throughput problem, it's a red flag.

---

### D-06 · Idempotency key derived, not supplied · Accepted

`sha256(mandate_id + "|" + canonical(intent))`. The caller cannot pass one.

**Rejected:** client-supplied keys (the common API convention). A compromised or confused agent could vary the key and defeat the guard. Deriving it means a replayed intent is *definitionally* the same key.

---

### D-07 · Sanitisation at the consumer, not the producer · Accepted

The merchant MCP server does not sanitise its own output. The buyer agent wraps everything it receives in `wrapUntrusted()`.

**Rejected:** sanitising server-side. The merchant is the untrusted party — asking it to sanitise itself is asking the attacker to be careful. Trust boundaries are enforced by the party that has something to lose.

---

### D-08 · The agent is not told the mandate's numeric limits · Accepted

It learns only whether an intent was allowed.

**Rejected:** giving the agent its budget so it can plan efficiently. If the model knows the exact cap, injection can steer it to an intent sitting precisely at the boundary — technically compliant, substantively an attack. Withholding forces honest proposals and lets the gate decide.

**Trade-off:** slightly worse agent efficiency, occasional avoidable denials. Visible in the false-refusal rate. Worth it, and being able to point at the metric that shows the cost is the point.

---

### D-09 · Amounts as JSON strings over the wire · Accepted

`"amount_paise": "48000"`.

**Rejected:** JSON numbers. `JSON.parse` silently loses precision above 2^53. In a payments system, silent numeric corruption is unacceptable even when the current values are small.

---

### D-10 · Branded `Paise` type · Accepted

`type Paise = bigint & { __brand: "Paise" }`.

**Rejected:** plain `bigint`. A raw bigint can be assigned from a quantity, an index, or a timestamp with no complaint. Four lines of types eliminate a bug class.

---

### D-11 · Delimited untrusted blocks with delimiter stripping · Accepted

`wrapUntrusted()` strips literal occurrences of the delimiters from the input before wrapping.

**Rejected:** wrapping without stripping. A product description containing the closing tag escapes the block. This is the obvious bug and there is a test named after it.

---

### D-12 · Hash chain with explicit field separators · Accepted

`entry_hash = sha256(prev_hash | seq | ts | actor | event_type | payload_hash)`.

**Rejected:** naive concatenation. Without separators, `("ab","c")` and `("a","bc")` hash identically, which permits constructing distinct entries with matching hashes.

---

### D-13 · No vector database · Accepted

**Rejected:** Qdrant or pgvector for catalog search.

The catalog is small, structured, and queried by exact SKU and category. There is nothing to retrieve semantically. Adding a vector store would have been resume decoration, and decoration in the money path is a liability.

*(Notable because the builder's previous project used Qdrant. Choosing not to reuse a familiar tool is the point.)*

---

### D-14 · Retry cap of one, then escalate · Accepted

On execution failure the agent may retry once on an alternate method. If a retry would breach the mandate, it escalates to human approval rather than re-planning.

**Rejected:** exponential backoff with several attempts. Each retry is a fresh chance to double-charge and a fresh opportunity for a loop to drain a budget. Escalation is a better failure mode than persistence when money is involved.

---

### D-15 · Held-out eval split committed before tuning · Accepted

30% of the corpus is hash-partitioned out, and `.heldout` is committed before any failure is fixed.

**Rejected:** reporting a single tuned number. The git timestamp is what makes the held-out figure credible rather than merely claimed.

---

### D-16 · Known failures published, not tuned away · Accepted

`eval/report.md` includes `unresolved_exceptions` with case IDs and one-line reasons.

**Rejected:** shipping a 100% claim. Razorpay's own brief says a cherry-picked result proves nothing and asks for an honest exception list. Four documented failures beat a perfect score a reviewer disproves in ten minutes.

---

### D-17 · Auto-capture, with no second gate at capture time · Accepted

Razorpay is configured to auto-capture, and uncaptured authorizations are set
to refund automatically rather than await manual dashboard capture.

**Rejected:** manual capture as a second authorization checkpoint before money
is claimed.

Praman's gate sits upstream of order creation. By the time a payment is
authorized, `evaluate()` has already returned ALLOW, the decision is in the
ledger, and no input has changed. A capture-time gate would re-evaluate
identical facts against the same mandate and reach the same answer, while
introducing an authorized-but-uncaptured state to track, reconcile and time
out. Complexity without control.

**Principle:** put the gate where the decision is. Checkpoints downstream of
the real decision point feel safer and are not.

Orphaned holds auto-refund because money held on a customer's card with no
merchant claim behind it is a liability nobody will monitor at 3am. When a
money flow ends ambiguous, default to returning funds.

---

### D-18 · TypeScript throughout; no Rust policy core · Accepted

**Considered:** reimplementing `packages/policy` in Rust, exposed to the Node
control plane via napi-rs or WASM.

The motivation was real. `Paise` is a branded `bigint`, and TypeScript brands
are erased at compile time — they give no runtime enforcement whatsoever. A
Rust `struct Paise(u64)` is nominal and survives to runtime: it cannot be
forged by a cast, by an untyped caller, or by a value that arrived as `any`.

Costed against what it would actually buy:

| Rust benefit | Applies here? |
|---|---|
| Memory safety | No — Node is already memory-safe; no buffers in the money path |
| Data-race freedom | No — single-threaded; the real risk is a *database* race, solved by a per-mandate advisory lock (D-05) |
| Exhaustive matching | Marginal — discriminated unions plus `noFallthroughCasesInSwitch` already give this |
| Runtime-surviving newtypes | **Yes — the one genuine win** |
| Performance | No — decision latency is dominated by Postgres and network I/O |

One real advantage, against a substantial cost: a second toolchain, and an FFI
boundary that is untyped in both directions. That last point is decisive —
values crossing FFI need runtime revalidation, so the change would introduce a
new unvalidated boundary in order to fix a problem caused by unvalidated
boundaries. It does not remove the class of risk, it relocates it.

**What was done instead.** Amounts enter Praman from exactly four enumerable
boundaries, each of which requires an explicit runtime conversion through
`paise()`. Identifying the boundaries and guarding them are separate claims;
status as of Block A:

| Boundary | Guard | Status |
|---|---|---|
| HTTP JSON bodies | `paiseFromJSON()` | implemented |
| Postgres rows (`BigInt`) | `paiseFromDb()` | implemented |
| Razorpay API responses | `paiseFromRazorpay()` | implemented |
| Catalog price lookup | `paiseFromDb()`, `packages/db/src/catalog.ts` | implemented |

All four now guarded. The catalog boundary and the general Postgres-rows
boundary turned out to be the same call site once `loadCatalogSnapshot` was
built — `catalog_item.price_paise` is exactly the raw `BigInt` column
`paiseFromDb` exists for, not a separate hydration path. `paiseFromRazorpay`
additionally checks `Number.isSafeInteger` in both directions — inbound on
Razorpay's response amounts, and via a matching outbound guard
(`toRazorpayAmount` in `executor.ts`) before a `Paise` is ever converted back
to a `Number` for the API call, closing the boundary from both sides.
`paiseFromJSON` validates with a strict pattern rather than trusting `BigInt`
coercion, and CI greps for `as Paise` casts outside `money.ts` — currently
the only one found is the sanctioned cast inside `paise()` itself. A class
wrapper (`class
Paise { constructor(readonly value: bigint) {} }`) would also survive
erasure without leaving TypeScript, and was rejected for the same
cost/benefit reason: object allocation per amount and rehydration through
every ORM and clone boundary, to guard entry points that already collapse
to a single validation call each.

**Deferred, not dismissed.** A Rust policy core with nominal newtypes is first
on the post-submission roadmap. The compile-time-only nature of the brand is a
real limitation and is stated as one rather than hidden.

---

### D-19 · Two-audience decision records · Accepted

`evaluate()` returns a `Decision` — the internal record, carrying `detail`
strings and `remaining_paise`. A separate `redact(decision): AgentVisibleDecision`
strips both, plus the `STEP_UP_THRESHOLD` / `STEP_UP_FIRST_MERCHANT`
distinction, before anything reaches the agent.

**Rejected:** a single `Decision` shape serving both audiences. The first
implementation did this, and its human-readable `detail` strings (`"exceeds
per-transaction limit 80000 paise"`) handed the agent its exact mandate limits
through the refusal message itself — the precise leak D-08 exists to prevent.
Two deliberately-oversized probe purchases would have reconstructed the whole
mandate from the denials alone.

**Consequence:** every decision now has two shapes and a mapping between them,
more surface area than shipping one type. Worth it — the leak was a structural
property of collapsing both audiences into one record, not a mistake at a
single call site, so nothing short of separating the shapes closes it for
good.

---

### D-20 · Redaction narrows the probe oracle; a denial-rate cap closes it · Accepted

`redact()` (D-19) stops the agent reading its exact mandate cap off a `detail`
string. It does not remove the deterministic ALLOW/DENY boundary itself — that
boundary is still an oracle. A binary search over quantity or amount
reconstructs the cap in roughly log2(range) probes instead of the two probes
the original leak allowed. Narrowed, not closed.

**What makes it exploitable today:** `LedgerDerivedState.txn_timestamps`
counts successful transactions only, so `VELOCITY_EXCEEDED` never fires on a
denial. Probing a mandate's boundary is currently free and unbounded.

**Rejected:** making denials non-deterministic to defeat the search. `evaluate()`
being a pure, reproducible function (D-02) is what makes the eval harness
meaningful; sacrificing that to close this gap would cost more than the gap
itself.

**What closes it:** a denial-rate cap — past some number of DENYs for a
mandate within a window, stop answering and escalate to a human, since
repeated refusals are themselves a signal. `LedgerDerivedState.denied_attempts`
was added now, while the type is still cheap to change; the cap that reads it
is Phase 5 work, alongside the other gates.

**Consequence:** stated honestly rather than silently narrowed and left
looking fixed. A `mandate_evasion` corpus case — an agent that binary-searches
its cap via repeated probes — is Phase 6 work, and this is the answer to
"what's in your missing percentage" until the cap ships.

---

### D-21 · Prisma for schema and typed access; raw SQL at the money path · Accepted

`@praman/db` owns the Prisma schema, migrations, and the generated client.
`packages/ledger` reads and writes through Prisma for everything an ORM can
express — but three things it structurally cannot, and don't go through it:
the per-mandate advisory lock (`pg_advisory_xact_lock`, D-05), the ledger's
append-only enforcement (the raising triggers, not a Prisma-level rule), and
the hash-chain traversal query. Those are raw SQL via `$queryRaw`/`$executeRaw`.

**Considered and rejected: no ORM, raw `pg` throughout.** Prisma is what Node
payment backends actually use in practice, migration history as versioned SQL
files is a genuinely better audit trail than hand-run scripts, and a typed
client over `payload: Json` catches a class of mistake raw `pg` won't. Discarding
it over three call sites it can't reach would be throwing away the 90% it does
well to avoid the 10% it doesn't.

**Considered and rejected: force everything through Prisma anyway.** An ORM
that cannot express `pg_advisory_xact_lock`, a `BEFORE UPDATE OR DELETE`
trigger, or a recursive chain-walk shouldn't be asked to fake it through
application-level workarounds — that trades a database-enforced guarantee for
an application-level convention, which is exactly the gap D-04 chose Postgres
to close.

**Consequence:** two query paths into the same database, which is real
surface area — a reviewer could ask why `ledger.ts` doesn't just use
`prisma.$transaction` throughout. The answer is that every ledger function
takes `PrismaTx` — the transaction-scoped client type — as a parameter and
never opens its own transaction, per the invariant that a ledger write and
the action it records commit together. `$queryRaw`/`$executeRaw` run against
that same `PrismaTx`, so the three raw-SQL call sites are still inside the
one transaction boundary, not a separate connection working around it.

---

### D-22 · Two-phase execution with an outbox record, not a single transaction · Accepted

**Supersedes** the single-transaction execution described in earlier
revisions of `HLD.md` and `INVARIANTS.md` invariant 5, which is unachievable
as stated.

**What forced this.** Empirical testing of Razorpay's test-mode API showed two
things its documentation does not: `receipt` is *not* enforced as unique —
two orders created back to back with an identical receipt returned two
distinct order IDs, no error — and order lookup by receipt (`GET
/orders?receipt=...`) lags creation by anywhere from a few seconds to over
fifteen, measured directly. A direct fetch by order ID, by contrast, was
consistent every time. The original single-transaction design wrapped the
Razorpay call inside the Postgres transaction and relied on "the next
reconcile will find any orphan." Neither half of that holds: a retry landing
inside the propagation window would find nothing and create a duplicate order.

**The underlying problem** is the dual-write problem: a database transaction
and an external API call cannot be made atomic, because no protocol exists
between them. Any design claiming otherwise is claiming something impossible.

**What is achievable, and is now guaranteed:** no external call is made
without a durable, committed record that it was about to be made.

- **T1** — under the per-mandate advisory lock: check our own idempotency
  record first (immune to Razorpay's propagation lag — it's a row in the same
  transaction, not a search index), verify the mandate, derive state, evaluate,
  append `intent` and `decision`. On `ALLOW`, write a `pending` idempotency
  record carrying the receipt and amount, append an `api_call` marked
  `attempted`, and commit.
- **The call** — outside any transaction, necessarily.
- **T2** — append `outcome`, resolve the record to `succeeded` or `failed`.

An orphaned order is therefore always accompanied by a row naming its receipt
and amount. Unknown unknowns become known unknowns.

**A bug this design caught before it shipped, not after.** The reconciler's
first draft built its `outcome` event payload without `mandate_id` or
`merchant_id`. `deriveState` filters ledger rows by
`payload->>'mandate_id' = ${mandateId}` — an outcome event missing that key
is invisible to *every* future `deriveState` call, for *every* mandate. A
reconciled captured payment would have silently never counted against its
mandate's budget cap: the exact kind of gap that lets a mandate spend past
its limit while the system believes it hasn't. Caught by re-deriving the
outcome payload's required fields from the `intent` ledger event (already
durable from T1, carries both) rather than trusting the pending record alone,
which doesn't store either field. A second, smaller bug in the same draft
mirrored the idempotency record's `succeeded`/`failed` status off whether an
order was *found* at all, not off the found order's own status — a declined
payment located during reconciliation would have been recorded as
`succeeded`. Both fixed before commit, both covered by
`reconcile.test.ts`'s assertion that the reconciled outcome event carries the
correct `mandate_id`.

**A second, unrelated hazard surfaced by the same verification pass.** The
ledger's integration tests `TRUNCATE ledger_entry` between runs — correct for
test isolation, but pointed at the same `DATABASE_URL` as everything else,
which means `pnpm test` was silently destroying real accumulated demo data
the day before submission. Fixed by giving tests their own
`TEST_DATABASE_URL` (separate database, migrated independently,
`vitest.config.ts` injects it for the test process only) and truncating
`ledger_entry` and `idempotency_record` together, so no idempotency row can
outlive the ledger entries it refers to.

**Rejected: client-supplied idempotency at the gateway.** Razorpay does not
dedupe by receipt, so there is nothing to lean on there.

**Rejected: cancelling the order as a compensating action.** A saga's
compensation is itself a network call with the same failure mode. It moves
the problem rather than removing it.

**Residual gaps, stated rather than hidden:**
1. Reconciliation refuses to act on records younger than 60 seconds
   (`RECONCILE_MIN_AGE_MS`), because within the propagation window a lookup
   returns nothing for an order that exists and a retry would double-charge.
   Correctness is bought with latency.
2. Between T1 and T2 the ledger records an attempt but no outcome, so
   `deriveState` does not count it as spend. A concurrent intent under the
   same mandate can therefore evaluate against a slightly understated budget.
   The window is one API call wide. Closing it means treating unresolved
   `api_call` entries as reserved spend — correct, and deferred.
3. A crash between the Razorpay call returning and T2 committing leaves a
   pending record; the reconciler resolves it, but the order exists
   unrecorded until it runs.
4. The reconciler does not hold the per-mandate advisory lock T1/T2 use,
   because `idempotency_record` doesn't store `mandate_id` (only the ledger's
   `intent` event does, requiring a lookup either way). The actual risk is
   low — `deriveState` already doesn't count in-flight spend per gap 2 above
   — but it's an inconsistency with the pattern used everywhere else, named
   rather than silently matched or silently skipped.