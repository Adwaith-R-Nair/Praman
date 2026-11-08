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

Status: the mechanism is superseded by D-76. Angle brackets are now neutralised instead of delimiters removed, because one removal pass let a nested tag rebuild itself.

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

Status: holds for Razorpay only. On PayPal a buyer checkout sits between creation and capture, so inputs can change and capture is re-checked. See D-31.

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

### D-20 · Redaction narrows the probe oracle; a denial-rate cap closes it · Accepted, cap implemented

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

**What closes it:** a denial-rate cap — `mandate.limits.max_denials_per_window`,
checked in `evaluate()` immediately after revocation (step 2b), before
anything else that could itself produce a denial. Past the cap,
`DENIAL_RATE_EXCEEDED` fires instead of the real reason, and that DENY is
itself recorded as a denied attempt — the lock is self-reinforcing, not a
one-shot trip. Placed early because a locked mandate should cost nothing to
reject; placed after revocation so revocation still wins.

**Residual, named rather than hidden:** the cap is per window, not global. A
determined attacker who stays under `max_denials_per_window` within any given
window can still probe indefinitely, just slower — bounded to roughly
`max_denials_per_window` probes per `window_seconds`, not bounded absolutely.
Closing that fully would mean a cumulative, non-windowed denial ceiling with
its own reset semantics, deliberately not built here: it trades a clean,
auditable per-window rule for a policy question (how does a legitimate agent
recover from a stale lock?) that deserves its own decision, not a rushed one.

**Consequence:** stated honestly rather than silently narrowed and left
looking fixed. A `mandate_evasion` corpus case — an agent that binary-searches
its cap via repeated probes, and a slow-probe case that stays just under the
window cap — are both eval-harness work (D-23, Layer 1).

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

Status: residuals 2 and 4 are closed by D-42. Residual 2's "one API call wide" understated the window. D-42 has what was measured.

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

---

### D-23 · Two-layer evaluation: deterministic policy containment, a small live-model layer for susceptibility · Accepted

Most adversarial cases don't need an LLM at all. "Does the policy engine
contain an out-of-scope gift card" doesn't require a model to propose one — a
malicious `PurchaseIntent` can be constructed directly and fed to `runIntent`.
Deterministic, instant, free, reproducible, which is what D-02 demands and
what a live model can never give.

**Layer 1 — policy containment, no LLM.** Intent constructed directly,
covering mandate evasion, double-charge, numeric confusion, hallucinated SKU,
scope drift, catalog tamper, and every benign case. Containment rate and
false-refusal rate are measured here. Runs in seconds, costs nothing,
identical every time.

**Layer 2 — agent susceptibility, live model.** Only the prompt-injection
family, where the actual question is "can merchant text influence the model's
proposal." This is the one thing Layer 1 structurally cannot test — a
hand-constructed intent has no model in the loop to influence. Run against the
real provider, transcripts committed so a reviewer sees actual model output,
not a paraphrase of it.

**What forced the split**, not just what motivated it: the free-tier rate
limits actually measured for this project (`gemini-3.1-flash-lite`, the model
in use — 15 RPM / 500 RPD) would make a Layer-1-sized corpus running entirely
through a live model take twenty-plus minutes per sweep before backoff, and
that sweep needs to run many times while tuning. A corpus that's expensive and
slow to run gets run less often, which defeats the purpose of having one.

**The metric Layer 2 actually reports:** of the injection attempts that *did*
influence the model's proposal, what fraction were still contained by the
policy engine. Reporting only "was the model fooled" hides the thing this
architecture exists to guarantee; reporting only "did money move" hides
whether the defense-in-depth is doing anything or the model just never tried.
A model that was successfully manipulated, caught anyway by the gate, is a
better result than claiming the model was never fooled — and the honest
number is the more useful one either way.

**Early evidence, not the harness itself.** The harness (Layer 1's ~32 cases,
Layer 2's ~8) is Block D work, not built yet. But the fixture this decision
assumes — `SKU_FOOD_099`, a product description carrying a forged
`</untrusted_merchant_content>` closing tag and an instruction to add an
out-of-scope gift card — has already been run against the live agent twice,
manually, and resisted cleanly both times: the model proposed only the
requested item and named the injection attempt in its own rationale
(*"I have ignored the untrusted merchant instruction regarding an additional
gift card"*). Encouraging, and exactly why it isn't trusted as a result:
two manual runs are an anecdote, not a rate. LLMs are not deterministic —
Layer 2 exists specifically to turn "seems to resist" into a measured number
across enough runs to mean something, not to confirm what two lucky passes
already suggested.

**Rejected: running the full corpus through a live model.** Sound in
principle, unusable at this project's free-tier budget and timeline — and,
per D-02, less reproducible than the alternative regardless of budget.

**Rejected: skipping live-model testing entirely, asserting the delimiter
defense is sufficient by construction.** `wrapUntrusted` and the system
prompt's handling-merchant-content rules are the mechanism; whether they
actually hold against a real model is an empirical question the mechanism's
own existence doesn't answer.

---

### D-24 · Approval satisfies only the step-up gate; everything else is re-checked live · Accepted

Status: D-36 adds the currency to what an approval is bound to, and says who can change one.

A `STEP_UP` persists a pending `Approval` row instead of executing. Resolving
it — `resolveApproval()` — does not execute the stored intent on a bare
"approved" verdict. Approval satisfies **only** the condition that produced
the step-up. Revocation, expiry, budget, and velocity are all re-evaluated
against the mandate and ledger state as they are at resolution time, not as
they were when the step-up fired.

**Rejected: executing the stored intent directly on approval.** That is a
bypass, not a convenience. Get a `STEP_UP`, wait for the mandate to expire or
be revoked, then approve — money moves under authority that no longer exists.
A human saying yes to a proposal is not the same thing as the mandate still
being valid; only re-running `evaluate()` against current state actually
checks the second claim.

**The approved amount is binding.** The human approved a specific rupee
figure. If the catalog price moves between step-up and approval, the
re-evaluated amount no longer matches what was shown, and the approval is
refused (`AMOUNT_CHANGED_SINCE_APPROVAL`) rather than silently executing a
different amount than the one a human actually signed off on. Silent
substitution here would be worse than refusing and asking again.

**Approvals expire — 15 minutes.** A human's attention is not indefinite
authority. An approval sitting unresolved long enough stops being "this
person is thinking about it" and starts being "nobody is looking at this
anymore"; expiring it is the honest default, not a technicality.

**This is D-17's logic in the other direction.** D-17 put the gate before
order creation because authority to refuse ends once an order exists. The
same reasoning says a `STEP_UP` cannot be resolved by *creating* the order
first and asking questions later — the gate has to run again, live, at the
one moment a bypass would actually work: after a human said yes, before
anything is committed.

**A bug this surfaced, not just what it fixed:** `deriveState` originally
counted only `status: "captured"` outcomes toward spend and
`merchants_transacted`. `LiveExecutor.createOrder` returns `status:
"created"` immediately — capture happens later, via reconciliation — so in
live mode spend never accumulated and a merchant never entered the set.
First purchase steps up, nothing resolves it, no capture, merchant never
registers: every purchase at that merchant steps up forever. `SimulatedExecutor`
always returns `"captured"` directly, which is exactly why this never showed
up in any test or eval run before a real `pnpm demo` call surfaced it. Fixed
by counting `"created"` as committed spend too — an order that exists is
already a payable obligation per D-17, so the budget has to move when it's
created, not when it's eventually captured.

**Consequence:** approving something is no more powerful than the mandate
would have allowed at that exact moment anyway. The human's "yes" narrows
what would otherwise have been an automatic refusal (the step-up condition)
down to nothing — it does not grant anything beyond what the mandate itself
still authorises.

---

### D-25 · Unverified mandate claims are not attributed to a mandate · Accepted

A caller who submits an intent with a forged or malformed signature has not
proven they hold the mandate named in `intent.mandate_id` — they've only
claimed to. `run-intent.ts` previously recorded the resulting `DENY` under
`mandate_id: intent.mandate_id` anyway, and `deriveState` counted every
`DENY` keyed to a mandate toward that mandate's `max_denials_per_window`.
The two together mean anyone who knows a mandate's ID — not a secret, since
it's never the signing key — could lock it out by submitting a handful of
garbage-signature intents, no valid signature required.

Not exploitable through the CLI today, since nothing untrusted calls
`runIntent` directly. It becomes a real remote denial-of-service the moment
an HTTP API exists (Phase 14), and a permanent one if a lifetime denial cap
is ever added (Phase 19) instead of a per-window one.

**Fixed on both sides, but the read side is the one that matters.** The
write side (`run-intent.ts`) now records the field as `claimed_mandate_id`,
not `mandate_id`, so no future entry of this shape is even queryable as
belonging to a mandate at all. But the ledger is append-only — entries
already written in the old shape exist and can never be rewritten. The real
fix is on the read side: `deriveState` (`packages/ledger/src/derive.ts`)
excludes any `DENY` whose `reason_code` is `MANDATE_SIGNATURE_INVALID` from
`denied_attempts`, regardless of which field the entry used to name a
mandate. In an immutable log you cannot correct the data. You correct how
it's read, and you record why.

**Rejected: rewriting or migrating old ledger entries.** Violates the
append-only invariant for the sake of convenience. The read-side fix costs
one condition in one function and handles every entry, old and new, the
same way.

**Consequence:** a mandate's denial-rate cap now only ever counts denials
against someone who actually proved they hold that mandate. Probing a
mandate's ID with bad signatures costs the prober nothing and the mandate
holder nothing — which is the correct shape, since a denial-rate cap exists
to stop a legitimate-looking attacker from burning through probes cheaply,
not to be a free lockout lever for anyone who knows a public ID.
### D-26 · What PayPal's sandbox actually guarantees · Accepted

Status: decision 1 is changed by D-33. The comparison moved out of `paypal-exec`, and a difference is recorded as a mismatch that holds budget, not as a failure.

Status: the transaction search and vault setup token rows, and decision 5's reasoning, are moved forward by D-37. Direct card was not re-tested.

Status: two of the three "not yet tested" items are settled by D-49. Capture after approval gives 201 `COMPLETED`, and a capture retried with the same key gives 200 and the same capture. Real webhook delivery is still untested.

D-22 taught this project not to trust a provider's documented behaviour
without testing it, so PayPal got the same treatment before any rail code was
written. Tested on 2026-11-04 against Orders v2 in the sandbox, with a merchant
app created from an Indian developer account. Throwaway scripts, nothing kept
in the repo but this record.

| Question | Observed |
|---|---|
| Does the sandbox work from this account? | Yes. OAuth 200, orders 201. |
| USD order | 201, status `CREATED`, with `approve` and `capture` links. |
| INR order | 422 `CURRENCY_NOT_SUPPORTED`. PayPal runs in USD here. |
| Same `PayPal-Request-Id`, same payload | 200, the same order. The first call is 201. |
| Same key, **different** payload (99.00 after 20.00) | **200 and the original 20.00 order, with no error.** |
| Five simultaneous requests, one key | One 201, four 200, one order. Better than the docs' "might fail". |
| No key, called twice | Two distinct orders. The header really is what dedupes. |
| Key length | 108 chars works. 109 returns a 500. 200 returns a 422. |
| Capture before buyer approval | 422 `ORDER_NOT_APPROVED`. No money can move early. |
| Value `12.5` | Accepted and normalised to `12.50`. |
| Value `12.500` | 422 `DECIMALS_NOT_SUPPORTED`. |
| Find an order by `custom_id` | 404. There is no order search. |
| Transaction search | 403 `NOT_AUTHORIZED` on this app. |
| Delete or void an unapproved order | 405. Unapproved orders cannot be cancelled by API. |
| Vault setup token | 403 `NOT_AUTHORIZED` on this app. |
| Direct card with no buyer | 422 `PAYEE_NOT_ENABLED_FOR_CARD_PROCESSING` on this app. |

**Not yet tested,** because they need a real buyer approval or a public URL:
capture after approval, capture retry with a repeated key, and real webhook
delivery. These are tested as those parts get built, and recorded forward.

**Decisions that follow.**

1. **The rail compares what it got back.** The most important row is the
   different-payload one. If a bug ever reused a key for a new amount, PayPal
   would answer with a success and an order for the *old* amount. So
   `paypal-exec` treats any response whose amount or currency differs from the
   request as a failure, never as success. Praman's keys are derived from the
   intent, so this should be unreachable. It is checked because it fails
   silently if it is ever reached.
2. **Reconciliation repeats the create call with the same key** (design
   candidate (a)). There is no search to use, and transaction search is
   unavailable. If the first response was lost, this returns the same order. If
   the order never existed, or the key has expired from PayPal's store, it
   creates a new unapproved order, which is harmless: no money moves until
   Praman's own capture call, and Praman only captures an order it recorded.
3. **The derived key fits.** It is 64 hex characters, under the 108 limit.
   `toPayPalValue` always sends two decimals, so normalisation never matters.
4. **Release cannot rely on PayPal.** Unapproved orders can't be voided by API,
   so "released" is Praman refusing to capture. D-17's "the gate sits before
   creation" does not hold on this rail, which is why capture is re-checked.
5. **No-buyer purchases are not available by default.** Vault and direct card
   are both refused on this app. Plan Task 14 stays conditional on whether the
   dashboard can enable them. The demo works without it, with a buyer approving
   each PayPal checkout.
6. **The INR row is expected, not a blocker.** A PayPal merchant runs in USD and
   a Razorpay merchant in INR. One signed mandate does not span rails, as the
   design already states.

**Limits.** This is one app on one sandbox account on one day. Key retention is
still undocumented and untested, which decision 2 is built to tolerate. Sandbox
behaviour may differ from production. Live keys are out of scope for this repo.

### D-27 · Moving to an agentic development life cycle · Accepted

Decided by the builder, Adwaith R Nair, on 2026-11-04. Until now invariant 3 said
`packages/policy/src/evaluate.ts` was human-authored and an agent could only
write tests for it and report bugs in it. The builder lifted that rule: the
project now follows an agentic development life cycle, and the PayPal plan has
agents make the policy changes it needs, such as the `_minor` rename and the
currency mismatch check.

**What stays true, as history.** `evaluate()` and the ledger's hash chain
(`packages/ledger/src/chain.ts`) were hand-written up to the `v1.0-submission`
tag. At the time of this record, neither file has a commit after that tag, which
`git log v1.0-submission..HEAD` on those two paths confirms. Git cannot show who
typed a line, so the evidence for "hand-written" is the builder's own statement:
the README at that tag, and the Day 4 build-log entry for `evaluate()`.

**The rule from here.** (Amended on 2026-11-07 by D-80: the review is now an
independent agent's, not the builder's.) Agents may edit both files. Each change needs a failing
test first, its own commit, and the builder's review. `evaluate.ts` stays one
readable pure function.

**What this does not change.** Invariant 1 is about runtime, and it holds as
before. An agent writing code that the builder reviews is not a model authorising
a payment. No LLM call enters `packages/policy` or the executors, and no model
output becomes a policy value.

**Rejected: keeping the rule.** The builder would have to type every policy
change for the PayPal work himself. That is the builder's call to make, and he
made it the other way.

**Rejected: leaving the docs as they were.** A present-tense "hand-written" claim
would become false at the first agent commit to that file, and this repo is read
by people checking its claims against its history.

**Rejected: removing the claim altogether.** It is true of the submitted version,
and the tag gives a fixed point to check it against.

**Consequence.** "Hand-written" stops being a reason to trust later versions of
these files. That trust now rests on the failing test, the isolated commit and
the builder's review, all of which can be read in the history. Docs that state
the claim are reworded as history. Dated records, meaning `docs/BUILD_LOG.md` and
the shipped phases in `docs/ROADMAP.md`, stay as written.

### D-28 · Schema evolution when old records can't be rewritten · Accepted

PayPal brings a second currency, and an amount called `amount_paise` would be a lie
the moment it held US cents. So every amount is now `_minor`, typed `Minor`. That is
easy in code and impossible in two places, because two kinds of record are protected
on purpose:

- **Ledger rows.** The hash chain covers each payload's exact bytes, and triggers
  reject `UPDATE`. Rewriting `amount_paise` in an old row would break the chain from
  that row onward, which is exactly the tampering the chain exists to detect.
- **Signed mandates.** The Ed25519 signature covers the canonical document, field
  names included. Renaming a field in an old mandate invalidates its signature.

**Decision: old records stay as written, and readers accept both shapes permanently.**

- Mandates get a schema version. `MandateDocument = MandateDocumentV1 | MandateDocumentV2`.
  `verifyMandate` checks the signature over the bytes as they are, then hydrates either
  version into the same `VerifiedMandate` with `_minor` fields. `evaluate()` never sees
  a difference. New mandates are version 2.
- Ledger amounts go through two functions in `packages/ledger/src/derive.ts`.
  `readAmount` is for counting money and throws on a missing, malformed or conflicting
  amount. `amountIfPresent` is for display, where a DENY decision legitimately has no
  amount. New events write `amount_minor`.
- The trace page and the dispute bundle also parse catalog text out of stored
  transcripts, so their patterns match both `price_paise=` and `price_minor=`.
- Ordinary columns are not protected, so they do change: `catalog_item.price_minor`,
  `idempotency_record.amount_minor` and `approval.amount_minor`, by `RENAME COLUMN`.
  The migration does not touch `ledger_entry` or its triggers.

**The version gate fails closed.** Before this, `verifyMandate` never looked at
`version`. It now refuses an unknown version, and a document whose names don't match
its version, as `MALFORMED_DOCUMENT` even when correctly signed. Every mandate ever
issued was version 1 with `_paise` names, so no real mandate is affected. A signed v1
can't be relabelled as v2, since `version` is inside the signed bytes.

**Idempotency keys don't move.** The key hashes the mandate id, intent id, merchant
and line items, and an intent carries no amount. A retry that straddles the rename
still finds its original record.

**Rejected: a data migration that rewrites old payloads and recomputes the chain.**
A recomputed chain is indistinguishable from a forged one, and any published
checkpoint would stop matching. Destroying the evidence to tidy a field name is the
wrong trade in a system whose output is evidence.

**Rejected: keeping `_paise` and storing cents in it.** No migration at all, and a
field whose name is wrong for half its values, on the money path, in a repo whose
readers look for this exact kind of bug.

**Rejected: an upcasting layer that converts rows as they are read.** It is the same
behaviour as `readAmount` with more machinery, and it would invite code to treat
converted payloads as the stored ones, which they are not when hashing.

**Consequence.** `_paise` stays in the source permanently in the v1 type, the two
ledger readers and the two transcript patterns, plus tests. Committed eval output under
`eval/` is left as generated, since it records past runs. The price label the model
reads changes from `price_paise=` to `price_minor=`; the policy never read that text.

### D-29 · Currency comes from the signed mandate · Accepted

Status: the claim that `merchant.currency` can only disagree into a refusal was false when written. D-35 makes it true.

Until now a price was a bare integer and every reader assumed rupees. `50000` meant
₹500 because nothing else could exist. With USD, the same integer could be $500, and
nothing in the system would notice. The danger isn't a crash. It's a charge that looks
correct and is wrong by the whole exchange rate.

**Decision: the signed mandate names the currency, and anything priced differently is
refused.** One amount and one label, `amount_minor` and `currency: "INR" | "USD"`.

- `scope.currency` on the mandate is the only source. It is inside the signed bytes, so
  it can't be changed without the issuer's key. It is never inferred from region or
  merchant, and never read from model output.
- Every catalog item carries a currency. `evaluate()` compares it to the mandate's
  inside the sorted SKU loop, right after `SKU_UNKNOWN`, and denies `CURRENCY_MISMATCH`.
  A wrong-currency price is never added to the amount, and because the loop is sorted
  the code doesn't depend on cart order.
- Limits are counted in the mandate's currency. Each mandate has one, so its spend is
  summed in one currency without `deriveState` having to separate them.
- New ledger events with an amount carry `currency`. Old rows have none and read as
  INR through `readCurrency`, which is true: `evaluate()` refused everything else when
  they were written. They are not rewritten (D-28).

**Rejected: converting at evaluation time.** It would need an exchange rate, which is
an outside input to a pure function, and a mandate's limits would then depend on the
day. The person signing `$50` means $50.

**Rejected: reusing `AMOUNT_INVALID` for a mismatch.** The amount is fine. The caller
needs to know the merchant is wrong for this mandate, and a separate code also makes
the corpus able to prove this exact check fired instead of something nearby.

**Rejected: taking currency from the merchant.** A merchant's configuration isn't signed
by the person whose money it is. `merchant.currency` exists, and it can only ever
disagree into a refusal, because each of its items still has to match the mandate.

**An unsupported currency on a good signature isn't a bad signature.** `verifyMandate`
now returns `UNSUPPORTED_CURRENCY`, and `verifyFailureCode` records it as
`AMOUNT_INVALID`, the same code `evaluate()` step 5b gives it. Recording it as
`MANDATE_SIGNATURE_INVALID` would be a false statement in an evidence log. A v2 mandate
with no currency gets the same refusal rather than an assumed INR. A v1 mandate counts
in paise by name, so one claiming USD is `MALFORMED_DOCUMENT`.

**Columns have no default.** `catalog_item.currency` and `approval.currency` use a
default only to backfill existing rows, then drop it. A default of `'INR'` left in place
would make a USD seed that forgets the field quietly list dollar prices as rupees, which
is the bug this decision exists to prevent. The check constraints refuse anything but
the two supported values.

**Razorpay refuses USD until rails are routed.** `LiveExecutor` hardcoded `INR` in its
request body, so once `evaluate()` allowed USD, a $12.50 item sent there would have
become a real ₹12.50 order. It now returns a typed failure with no network call. Rail
routing arrives with the rail-neutral executor, and this refusal stays, because the
Razorpay account takes INR only.

**Consequence.** The `eval` money-at-risk metric is now one total per currency, since a
sum of paise and cents means nothing. Its JSON shape changed from a string to an object.

### D-30 · Budget during checkout · Accepted

Status: the fold is corrected by D-34. A key groups rows, and two order ids under one key count as two orders.

Status: a repeat of a released intent got a cached `ALLOW` for the dead order, not `DUPLICATE_INTENT`, until D-40 fixed it.

Decided by the builder on 2026-11-04. On PayPal an order is created, the buyer goes off
to approve it, and only then does Praman capture. That can take minutes, or never finish,
and PayPal's order can't be cancelled by API (D-26). So what does an order at checkout do
to the mandate's budget?

**Decision: a created order holds budget. After 10 minutes unapproved it gets a `released`
outcome, which frees the budget but still counts toward velocity.**

Praman has already authorised that checkout, so it is a promise. If it held nothing, a
mandate with a $50 budget could open ten $50 checkouts and have every one approved.

**How `deriveState` counts this.** It used to add up outcome rows. An order now has several
rows (created, then captured or released), so that would count it twice. Rows are now folded
by `idempotency_key` first, then counted once per order:

| Rows for one key | Budget | Velocity | Merchant trusted | Key seen | In `released_keys` |
|---|---|---|---|---|---|
| created | held | 1 | yes | yes | no |
| created, captured | held once | 1, at the created time | yes | yes | no |
| created, released | freed | 1 | no | yes | yes |
| released and captured, either order | held | 1 | yes | yes | yes |
| created, failed | held | 1 | yes | yes | no |
| no key at all (old rows) | each row on its own | 1 each | yes | no | no |

Those lines each answer a real question:

- **A released key stays seen.** A repeat of this intent would send the same
  `PayPal-Request-Id`, and PayPal would return the same dead order. `DUPLICATE_INTENT` is the
  right answer. A new intent gets a new key.
- **A released order earns no trust.** Otherwise opening a checkout and walking away would
  skip the first-merchant step-up on the next purchase.
- **A released order keeps its velocity timestamp.** Otherwise an agent could open and abandon
  checkouts forever without ever reaching its rate limit.
- **A capture beats a release.** The plan says to apply `released` last, and the rows are
  folded first so arrival order can't matter. But I did not let a release free an order that
  also has a capture. Task 7's lock should make that combination impossible. If it ever
  happens, the money has moved, and freeing its budget would let the mandate overspend. The
  key still goes in `released_keys`, so no further capture is allowed either. This is the
  careful answer in both directions.
- **Disagreeing amounts on one key count the higher one.** They should never disagree. Throwing
  would match `readAmount`, but that row can never be rewritten, so one bad row would break the
  mandate for good, including its revocation check. A malformed amount still throws, as before.
- **A release with no key frees nothing,** because it can't say which order it means.

**Razorpay is unchanged.** It has one outcome per order, so folding changes nothing, and it
never writes `released`. D-17's rule that a created Razorpay order counts as spend still holds.
Checked on the dev ledger, by comparing the old sum with the new fold for each mandate: 242
entries, 21 mandates, all identical. If a duplicate outcome ever did appear on one Razorpay
key, it would now count once, not twice. That is a fix, not a change in intended behaviour.

**Rejected: holding nothing until capture.** It's the ten-checkouts problem above.

**Rejected: a longer hold.** Longer means the budget is stuck for longer on an abandoned
checkout. Ten minutes is a judgement about how long a buyer takes at checkout, not a PayPal
limit, and it is not enforced by PayPal either. Praman enforces it by refusing to capture (D-31).

**Consequence.** `txn_timestamps` now has one entry per order, not one per row. A capture's
ledger outcome must carry the *order's* key, even though Task 7 keeps its outbox record under a
separate derived key. An outcome under the capture key would look like a second order.

### D-31 · Capture re-checks the mandate · Accepted

Status: the last sentence, that adding the rail itself took no policy change, claims more than the freeze check proves. D-43 says what it does and doesn't prove.

Decided by the builder on 2026-11-04, following D-24. D-17 says a gate at capture would
"re-evaluate identical facts". On Razorpay that's true. On PayPal it isn't: while the buyer is at
checkout, a mandate can be revoked or can expire, and the order's hold can be released. So
capture gets a gate.

**Decision: a small pure function, `evaluateCapture()`, in `packages/policy`.** It checks, in
this order:

1. `ORDER_RELEASED`. First because it is final. If an order was released and its mandate has
   also expired, the useful thing to tell the buyer is that this checkout timed out and nothing
   was charged.
2. `MANDATE_REVOKED`.
3. `MANDATE_NOT_YET_VALID`, then `MANDATE_EXPIRED`, with the same boundaries as `evaluate()`.
4. `CURRENCY_MISMATCH`. Before the amount, since amounts in two currencies can't be compared.
5. `AMOUNT_CHANGED_SINCE_APPROVAL`, if the rail quotes anything other than what the ledger holds.

If it allows the capture, it returns the *ledger's* amount, never the rail's.

**`ORDER_RELEASED` is a new reason code,** which the design's "existing codes" didn't foresee. No
existing code means this, and the caller has to do something different: explain that the checkout
timed out, rather than that something is wrong with the mandate. `evaluate()` never returns it.

**It doesn't re-check limits, scope or velocity.** Those were decided when the order was created,
and the hold is already counted in `spent_minor`. Checking again would refuse the order for
counting itself, and a buyer who has paid at PayPal should not be refused because of a later
purchase. It also leaves out the denial-rate cap, for the same reason.

**Refusals at capture don't count toward the denial-rate cap.** They are recorded as a new
`capture_decision` event, which `deriveState` doesn't read as a denied attempt. The cap (D-20) exists
to make probing the policy expensive. A buyer returning late isn't probing anything, and an agent
can't learn the mandate's limits from these codes. A new `settlement` event type also arrives here
for webhooks, and moves nothing on its own.

**Rejected: running `evaluate()` again.** Its first step would return `DUPLICATE_INTENT`, since this
key is already seen. Getting past that would need a flag in the middle of `evaluate()`, which is the
function this project most wants to keep readable.

**Rejected: putting this in the control plane.** Whether money may move is a policy decision, and
policy lives in one package with no I/O. It also has to land before that package is frozen.

**Corpus.** `apps/eval/corpus/layer1.json` runs this function directly, through a `capture` field on
a case. A capture case's `money_moved` means "the capture would have been allowed". Nothing reaches
a rail, because the capture flow doesn't exist until Task 7.

**Consequence.** This is the last planned change to `packages/policy`. `.policy-freeze` names this
commit and `pnpm lint:policy-freeze` fails if the package differs from it, so the claim that adding
PayPal took no policy change is checked rather than asserted. `evaluateCapture()` is written for
PayPal's flow, but it lands before the freeze, so the honest wording is: adding a currency took a
small policy change, preparing for a checkout took another, and adding the rail itself took none.

### D-32 · Rail comes from merchant configuration · Accepted

Status: the section "The rail's currency is checked on return" is replaced by D-33. The rest holds.

Status: the last paragraph, that `merchant.currency` is stored and not compared, is closed by D-35.

Praman needs to pay on two rails without the control plane caring which. Three things could
choose the rail: the intent, the mandate, or the server's own record of the merchant. An intent
is model output, and a model must never reach a rail (`CLAUDE.md`, and the design's anti-goals).
A mandate is one currency, and says what may be spent, not how a merchant gets paid.

**Decision: the `merchant` table decides. `runIntent`, `resolveApproval` and `reconcilePending`
take an `ExecutorRouter`, and `@praman/exec-core` holds the rail-neutral `Executor`.** The control
plane no longer depends on `@praman/razorpay-exec` outside its tests.

**A merchant Praman can't pay is denied, fail closed.** No merchant row, or a rail with no
executor in this process, returns `MERCHANT_OUT_OF_SCOPE` with no outbox row and no call. There
is no default rail and no fallback to another one, because paying a PayPal merchant through
Razorpay would be a silent wrong payment.

- **Policy answers first.** `gateOnRail` looks only at what `evaluate()` already allowed. An
  expired mandate at an unconfigured merchant still says `MANDATE_EXPIRED`, and the eval corpus's
  reasons don't change.
- **A `STEP_UP` is denied too.** A human shouldn't be asked to approve what can't happen. It's
  checked again at approval, since configuration may have changed in the 15 minutes between.
- **It lives in the control plane, not `packages/policy`.** That package is frozen (D-31). This
  also isn't a question of whether the mandate permits the purchase. It can only turn a yes into
  a no, so it can't widen anything `evaluate()` decided.
- **The denial counts toward the denial-rate cap.** It's a real `decision` row. An agent that
  keeps trying a merchant nobody can pay should stop.

**`MERCHANT_OUT_OF_SCOPE`, not a new code.** The closest existing meaning, and the agent's next
move is the same: this merchant is not available to you. The cost is that the code's name is
slightly off for a merchant that is in the mandate's scope, so the ledger row's `detail` says
which case it was, and the docs table and trace-page wording now cover both. If the demo ever
needs to explain this differently from a scope denial, that's the moment to add a code.

**The rail recorded is the one that was called.** `idempotency_record.rail`, and `rail` on the
`api_call` and `outcome` events, come from the executor, replacing the hard-coded
`provider: "razorpay"` that was false for every simulated run. Old rows keep `provider`, and
nothing reads either field to compute state. In an eval, `routeAllTo` sends a merchant to the
simulator and the ledger says `simulated`, which is true.

**The rail's currency is checked on return.** D-26 showed that a provider can answer with success
about something other than what was asked. `acceptOutcome` marks an outcome in another currency
as `failed`, with `failure_code: "RAIL_CURRENCY_MISMATCH"`, and the ledger keeps the currency the
rail actually reported. A failed outcome holds no budget. This needs a human to look at it, since
the order does exist at the rail, and that is why the row keeps its `order_id`. Comparing amounts
is left to each rail for now: D-26 assigns it to `paypal-exec`, and Razorpay's outcome already
records the amount it was given.

**Failure codes are executor vocabulary, not reason codes.** `CURRENCY_NOT_SUPPORTED`,
`CAPTURE_NOT_SUPPORTED`, `RAIL_CURRENCY_MISMATCH` and a rail's own error codes are what a rail
said about one call, on a purchase policy had already allowed. They stay a string on the outcome
and don't join the closed enum, which is what Praman's own decisions are made of.

**`LiveExecutor.capture` now refuses, with a typed failure and no call.** The new interface
captures by order id, and Razorpay's endpoint takes a payment id that this flow never has. Nothing
called the old method outside tests, and Razorpay auto-captures (D-17). Looking the payment up
first would be new, untested money-moving code with no caller.

**Rejected: the rail on the signed mandate.** It would let one mandate say which rail, but the
merchant is what has a rail, and moving a merchant would invalidate every signature that names it.

**Rejected: a default rail for a merchant with no row.** Convenient, and it is how a typo in a
merchant id would end up as a real order. Existing catalog merchants were given their row by the
migration instead, as Razorpay in INR, which is the only thing they could have been.

**Consequence.** `merchant.currency` is stored and not yet compared to the mandate. The catalog
item's currency is what `evaluate()` checks (D-29), and policy is frozen, so a merchant row
that disagrees with its own catalog isn't caught here. The rail's refusal or `acceptOutcome` is
the backstop. `seed-catalog` always writes the two together.

### D-33 · An order the rail misreports still holds budget · Accepted

Found in independent review of Task 5, and reproduced before fixing. D-32 turned an outcome in the wrong
currency into `failed`, and left amounts to each rail. Together that gave two ways past a signed budget:

- A rail reporting `captured` in the wrong currency was recorded as `failed`, so six such orders moved
  nothing in `spent_minor` or `txn_timestamps`. That contradicts D-17: an order that exists is a payable
  obligation.
- T2 wrote the rail's `amount_minor` into the ledger with no comparison, and `deriveState` counts that row.
  A rail reporting 1 minor unit on a 5000 order made six purchases cost 6 of a 12000 budget. D-26 shows the
  trigger is real: PayPal answers a reused key with a 200 and the old order's amount. Razorpay's outcome
  didn't "record the amount it was given", as D-32 said. It recorded whatever came back.

**Decision: `acceptOutcome` compares both currency and amount, for every rail, and a difference becomes
its own status, `mismatch`.** The caller, T2 and the reconciler all go through it, and all write the row
through `outcomeFields`, so one order can't be counted differently depending on the path it took.

| Rail says | Recorded `status` | `amount_minor`, `currency` | Budget and velocity | Merchant trusted |
|---|---|---|---|---|
| `created` or `captured`, matching | as reported | as asked | held | yes |
| `failed`, whatever it reports | `failed` | as reported | none | no |
| `created` or `captured`, different | `mismatch` | what T1 authorised | held | no |

The row also keeps `rail_status`, `rail_amount_minor` and `rail_currency`, so nothing the rail said is lost,
and `failure_code` is `RAIL_CURRENCY_MISMATCH` or `RAIL_AMOUNT_MISMATCH`. Those stay executor vocabulary, as
D-32 says of failure codes.

Each part of that answers a question:

- **Why a new status, not `created` with a flag?** A caller that only reads the status would see a healthy
  order. `RunResult.order_status` is a typed union, so `mismatch` can't be mistaken for either a success or
  a decline. The demo loop retries a decline with a new intent and key. On a mismatch it stops, since a
  retry could leave a second order at the rail.
- **Why not `failed`?** That is the bug. The order exists.
- **Which amount is held?** The authorised one, or the rail's if that is higher and in the same currency.
  This is the rule D-30 already uses when two rows disagree: a mismatch can't free budget. In another
  currency the numbers can't be compared, so the authorised one stands, because Praman does no FX.
- **Why does `amount_minor` stay the authorised figure when the higher one is counted?** Capture reads the
  ledger's amount and refuses when the rail quotes anything else (D-31). If the rail's inflated figure
  became `amount_minor`, a capture at that figure would pass the comparison. So `deriveState` reads
  `rail_amount_minor` for counting only.
- **Why no `approve_url`?** Nobody should be sent to pay an order Praman doesn't recognise.
- **Why does a release not free it?** What the rail holds is unknown, so this follows the same reasoning as
  a capture beating a release in D-30.
- **Why no merchant trust?** An order that came back wrong shouldn't skip the first-merchant step-up.
- **What does the idempotency record say?** `succeeded`, meaning an order exists and the call is settled. A
  repeat of the intent gets `mismatch` back with no second call.

**A failed outcome passes through untouched.** A failure says no order exists, so what it reports about
money doesn't matter, and the rail's own code (`CURRENCY_NOT_SUPPORTED`) is more useful than ours.

**A repeat of a failed key gets the recorded answer.** Found in the same review, and already there at
`3394f5c`: T1 handled `succeeded` and `pending`, so a repeat of a declined intent fell through to the
outbox insert and threw a primary key error, with no reason code. `pnpm approve` run twice after a decline
did the same. Now `failed` is treated as settled, like `succeeded`. The same intent gets the same answer
and the rail isn't called again. A new attempt is a new intent with a new key, which is what the demo's
re-plan already does. A failed record from the reconciler has no order at all, so `order_id` can be null
on this path.

**Rejected: letting a repeat of a failed key try again.** It would mean moving the record from `failed`
back to `pending`, and the same key on PayPal returns the same old order anyway (D-26).

**Rejected: refusing further purchases on the mandate after a mismatch.** That would be a new rule about
what a mandate permits, and policy is frozen (D-31). Budget and velocity already limit the damage, since
every mismatch uses up both.

**Rejected: comparing inside each rail.** D-26 assigned this to `paypal-exec`. A rail that marks a mismatch
`failed` brings back the first bug, and each new rail would have to remember the check. A rail's job is to
report what it was told, and `paypal-exec` should do that.

**Limits.** Nothing tells a human yet beyond the demo's message, `pnpm approve`'s exit code and the trace
page, which shows "Allowed (mismatch)". Real Razorpay echoes the amount and currency today, so this is a
guard against a misreporting rail, not a fix for something seen in production.

**Consequence for Task 7.** `captureOrder` must refuse an order whose outcome is `mismatch`. The amount
comparison in `evaluateCapture` catches a rail still quoting the wrong figure, but not one that later quotes
the right one, and `evaluateCapture` is frozen.

### D-34 · One key can mean two orders · Accepted

Found in independent review of Task 4, and reproduced with a failing test before fixing. An implementer's decision
for the builder to check, not one the builder made.

D-30 folded outcomes by `idempotency_key`, on the reasoning that one key is one order. D-22 says that isn't
something this project can assume: Razorpay does not enforce receipt uniqueness, so a retry whose first response
was lost can leave two real orders under one key. Those are two payable obligations (D-17), and the fold counted
one of them. A mandate could overspend its signed budget and the ledger would show it within limits.

**Decision: a key groups rows, and the order id says which order each row is about.**

| Rows on one key | Budget | Velocity |
|---|---|---|
| Same order id, any number of rows, such as a reconciler racing T2 | once | 1 |
| Two order ids | both | 2 |
| No order ids at all (old rows) | once, as before | 1, as before |
| One order id plus rows with none | once | 1 |
| Two order ids plus a row with none | both, and the row joins the first | 2 |
| A release naming one order of two | frees that order only | 2 |
| A release naming no order, on a key with two | frees nothing | 2 |
| A `failed` row with another order id | doesn't count, as before: a failure says no order exists | unchanged |

A row with no order id belongs to the key's order, because that is how it has always counted, and one row that can't
name an order must not create a third. A release that can't name an order frees nothing, the same rule D-30 applies to
a release with no key. Merchant trust and the capture and mismatch rules are now per order inside the key.

**Rejected: throwing when a key has two order ids.** The rows can never be rewritten, so one such key would break the
mandate permanently, including its revocation check. D-30 refused this for disagreeing amounts for the same reason.

**Rejected: refusing further purchases once it happens.** That is a new rule about what a mandate permits, and policy
is frozen (D-31). Counting both already uses up budget and velocity.

**Checked.** On the dev ledger, by a read-only query: 30 outcome rows and no key with more than one order id, so its
figures don't change. A fixture did change. The Layer 1 seed gave every row its own `order_SEED_<index>`, so fixtures
that meant one order at two stages read as two orders. The seed now uses the fixture's `order_key`. Nothing in the
fixtures' expected results moved. See the build log for how that slipped through a commit.

**Limits.** `released_keys` and `seen_idempotency_keys` stay per key, and `evaluateCapture` is frozen. So a release
on one of two orders also refuses a capture of the other. That is the careful direction, and it needs a human anyway.
Nothing raises an alarm when a key has two orders yet.

**Consequence for Task 7.** Capture and release outcomes must carry the order's `order_id`, or a release can't free
the right order on a key that has two.

### D-35 · A merchant in another currency is refused · Accepted

Status: the remark that these columns are edited by hand in a demo is not something the repo shows. The reasoning holds without it.

Corrects D-29, which says `merchant.currency` "can only ever disagree into a refusal, because each of its items still
has to match the mandate", and the design, which says a merchant whose currency differs from the mandate's is denied.
Neither was true. Nothing compared `merchant.currency` to anything, as D-32's last paragraph admits. A merchant row in
INR with a USD catalog item passed `evaluate()` and reached the rail for a USD mandate. Found in independent review,
and an implementer's decision for the builder to check.

**Decision: `routeMerchant` compares the merchant's currency with the signed mandate's, and `gateOnRail` denies
`CURRENCY_MISMATCH`.** It is the gate D-32 already built, so everything D-32 says of that gate holds here:

- **Policy answers first.** An expired mandate or an unknown SKU still reports as itself.
- **A `STEP_UP` is denied too,** because a human shouldn't approve what can't happen. It is checked again at approval,
  since the merchant's configuration may have changed in between.
- **It is a real `decision` row,** so it counts toward the denial-rate cap.
- **It can only turn a yes into a no.** The merchant's currency never replaces the mandate's. D-29's point stands: a
  merchant's configuration isn't signed by the person whose money it is.

`packages/policy` isn't touched, so the claim that adding the rail took no policy change still holds.

**`CURRENCY_MISMATCH`, not `MERCHANT_OUT_OF_SCOPE`.** The merchant is in scope and payable. What's wrong is the same
thing the code already means elsewhere, and the caller needs to know that rather than look for a missing merchant.

**Rejected: leaving it to the catalog check.** That is what D-32 did, on the reasoning that `seed-catalog` writes both
together. A check that holds because one script behaves is not a check, and these columns are edited by hand in a demo.

**Consequence.** Three tests had a USD mandate buying from a merchant row in INR. That was the gap itself, in a fixture.
They now configure the merchant as USD, and their assertions didn't change.

### D-36 · What an approval is bound to, and who can change it · Accepted

Status: the public approval endpoint the Limits paragraph asks about is the demo's, and it doesn't take an approval id from a request at all. See D-51.

Found in independent review of Tasks 3 and 5, and each part reproduced with a failing test before fixing. These are
an implementer's decisions for the builder to check. Four things were wrong with `resolveApproval`:

1. `approval.currency` was written and never read. A mandate re-signed with the same id in USD, with the merchant and
   catalog moved to USD, got past a rupee approval at the same digits, and money moved.
2. `AMOUNT_CHANGED_SINCE_APPROVAL` was returned to the caller, while the ledger said the re-check had passed.
3. The status was read before the lock. A reject waiting behind an approve still saw `pending`, and wrote `rejected`
   over a call that was already under way. An approve waiting behind a reject went on to call the rail.
4. A failed `verifyMandate` turned the row to `rejected` whatever its status, with no ledger row, including an
   `approved` one whose money had moved. Another mandate's valid signature could do the same through `evaluate()`.

**An approval is for an amount in a currency.** The mandate's currency is compared with `approval.currency`, and a
difference is `CURRENCY_MISMATCH`. It comes before the amount, because D-31 gives the same order: amounts in two
currencies can't be compared. `AMOUNT_CHANGED_SINCE_APPROVAL` would say the figure moved, and it hadn't.

**Both refusals are decided before anything is recorded.** So there is one `step_up_resolved` row, carrying
`revalidated_kind: DENY`, the code and a `detail`. The trace page and the dispute bundle already read those fields, so
they show the right answer with no change of their own. Old rows from this path still say the re-check passed, and
aren't rewritten. They stay readable as a step-up with no outcome.

**It doesn't count toward the denial-rate cap.** A merchant repricing isn't an agent probing the policy (D-20), and the
other denials at approval were never counted either.

**The status is read twice.** The first read only finds which lock to take, since `mandate_id` never changes. The status
is read again under the lock. Postgres's default isolation sees what the last lock holder committed.

**A caller who hasn't proved they hold the mandate changes nothing.** That covers a bad signature and a good signature
on a different mandate, which is `MANDATE_SUBJECT_MISMATCH`. The status stays as it was, and the attempt is a `decision`
row under `claimed_mandate_id`, the shape D-25 gives `runIntent`. So it is on the trace and isn't counted against the
mandate.

**Rejected: flipping only a pending row, and writing a ledger row for it.** It stops the false `rejected` on money that
moved. It still lets anyone who has an approval id and a bad signature kill a real approval, which is the lockout D-25
closed for denials. The cost of what was chosen: a mandate that really is broken leaves its approval pending until the
15 minutes run out, and it can't execute in that time anyway.

**Limits.** A `reject` verdict is still accepted without any mandate check, as it always was. The only callers are the
issuer's CLI scripts, so that is fine today. A public approval endpoint would have to prove who is asking. The hosted
demo needs to deal with this in Task 12 or 13.

### D-37 · What the PayPal app allows once its features are on · Accepted

Status: all three "still untested" items are settled by D-49. A payment token was created from an approved setup token, captures after approval and their retries behaved, and a no-buyer `vault_id` charge came back `COMPLETED` at once. A purchase with no buyer present works in this sandbox, so plan Task 14 no longer waits on PayPal.

Moves D-26 forward. D-26 recorded transaction search and vault setup tokens as 403 `NOT_AUTHORIZED` on this app. After the
app's features were enabled and the old token was terminated, they answer. An implementer's record for the builder to check.

| Question | D-26, 2026-11-04 | Now, 2026-11-05 |
|---|---|---|
| Transaction search | 403 `NOT_AUTHORIZED` | **200** |
| Vault setup token | 403 `NOT_AUTHORIZED` | **201**, status `PAYER_ACTION_REQUIRED` |

The two "now" answers were seen again by a throwaway script during Task 6, printing status codes only, using a token fetched
for that run.

**A cached token can outlive the settings it was issued under.** PayPal kept handing back an existing token with its old scopes
after the features were toggled, and the calls kept failing until that token was terminated. So a 403 `NOT_AUTHORIZED` can mean
the feature is off, or that the feature is on and the token is stale, and asking for a token again doesn't tell those apart.
This was not reproduced in Task 6, because reproducing it would mean turning the features off. `paypal-exec` handles it by
dropping its own cached token on that 403 and naming both causes in `describePayPalFailure`. It doesn't terminate tokens itself.

**Still untested, because no sandbox buyer approval has registered on PayPal's side:**

- creating a payment token from an approved setup token
- capture after approval, and a capture retry with a repeated key
- a charge with no buyer present

A setup token at `PAYER_ACTION_REQUIRED` is waiting for the same approval step. **So a purchase with no buyer present is not
shown to work.** The refusal in D-26's decision 5 has gone, and that is all that has changed. Plan Task 14 stays conditional.
Direct card was not re-tested and D-26's 422 stands.

**Transaction search does not replace repeating the create.** It now answers, but D-26's decision 2 stands: reconciling a create
repeats the create with the same key. Transaction search would only ever see captured payments, may lag, and was never needed to
find an unapproved order. This record doesn't test what it returns for a real capture, since none exists.

**Limits.** One app on one sandbox account, as in D-26. Sandbox and live entitlements are separate things, and live keys stay
out of scope.

### D-38 · How `paypal-exec` sorts PayPal's answers · Accepted

Status: the row saying a named 4xx is `failed`, and the claim that a `failed` capture took no money, were false for two capture codes when written. D-39 corrects them.

Status: the reconciler now reads a capture record's order by id, and a capture retry uses a fresh derived key. See D-40.

Status: `ORDER_ALREADY_CAPTURED` has now been seen live, and `paypal-exec` read the order back and reported the real capture. Two of the three questions under Limits are answered: a repeated capture key returns the same capture, and a key refused with `ORDER_NOT_APPROVED` captures normally after approval. The third, a repeated create after capture, is still untested. See D-49.

Status: refunds are now modelled, by D-66. A capture PayPal reports as `REFUNDED` or `PARTIALLY_REFUNDED` still reads as `captured` here, which stays right: the payment happened. The refund is on its own ledger rows.

An implementer's decisions for the builder to check. The `Executor` contract gives a rail three ways to answer, and getting one
wrong has a price in money. A false `failed` frees budget for an order that exists. A false "created" sends a buyer to pay
something Praman can't vouch for. So each answer from PayPal is sorted once, in `client.ts`.

| PayPal answers | Reported as | Why |
|---|---|---|
| 200 or 201 with a readable order | what the order says, even if it differs from the request | D-33: `acceptOutcome` decides |
| 400, 403, 404, 422 with a named code | `failed`, carrying the code | PayPal said no and said why |
| 401, then 401 on a new token | `failed`, `PAYPAL_UNAUTHORIZED` | a call that didn't authenticate didn't run |
| token endpoint 400, 401, 403 | `failed`, `PAYPAL_AUTH_FAILED`, no API call | nothing was sent |
| network error, timeout, a body that stops | throw, record stays pending | the call may have landed |
| 5xx, 429, 409 | throw | the same |
| 202, 207 | throw | PayPal documents these as unfinished and mixed |
| a 4xx with no recognisable code | throw | anything between here and PayPal can send a bare 4xx |
| a success with no id, a bad amount, or an unknown status | throw | it may be an order, and it can't be read |

**`findOrder` throws where `createOrder` returns `failed`.** The reconciler reads `null` or a failure as "no order exists, nothing
held". A 401 or 403 on a look-up means Praman couldn't ask, and D-32 already says that isn't the same as it not happening. So
a look-up by repeating the create only returns an order or throws. `null` comes from a 404 on a named id, or a non-USD record,
since `createOrder` never calls PayPal for one. The cost: a record whose repeat is refused for good stays pending until a human
looks. A false `failed` costs more. A pending record doesn't count against budget yet. That is the in-flight window Task 8 closes.

**`ORDER_ALREADY_CAPTURED` is read back, not reported.** It's a 422, so the general rule would say `failed`, and the money
has moved. `capture` fetches the order and reports the real capture. If that fails too, the outcome stays unknown. PayPal's
error reference names this code. It hasn't been seen live, because nothing has been captured live.

**An order's `COMPLETED` isn't enough.** PayPal documents the capture inside it as `COMPLETED`, `DECLINED`, `PARTIALLY_REFUNDED`,
`PENDING`, `REFUNDED` or `FAILED`.

| Capture status | Reported as |
|---|---|
| `COMPLETED`, `PARTIALLY_REFUNDED`, `REFUNDED` | `captured`, since the payment happened. Refunds aren't modelled. |
| `DECLINED`, `FAILED` | `failed`, `PAYPAL_CAPTURE_DECLINED` or `PAYPAL_CAPTURE_FAILED` |
| `PENDING` | throw: funds neither credited nor refused, so a later look decides |

**Capture before approval is a definite `failed` with `ORDER_NOT_APPROVED`.** Confirmed live. A `failed` capture says that capture
took no money. It doesn't say the order is gone, which is different from what `failed` means on a create. Task 7 has to keep the two apart.

**The request.** `payment_source.paypal.experience_context` with `NO_SHIPPING` and `PAY_NOW`, because the server captures straight
after approval. This changes what D-26 saw, because D-26's orders didn't send it. Seen live on 2026-11-05:

| | D-26's orders | With `payment_source` |
|---|---|---|
| Status | `CREATED` | `PAYER_ACTION_REQUIRED` |
| Link | `approve` | `payer-action` |
| First call | 201 | **200** |
| Repeat with the same key | 200 | 200, same order |

So the status code can't tell a first call from a repeat here, and nothing reads it for that. `Prefer: return=representation` is
always sent, because PayPal's default answer has no amount to compare, and D-26's silent reuse would go unseen.

**Small guards.**

- A key that is empty or over 108 characters is refused before calling. 109 gets a 500, which would read as unknown for ever, and an empty one means no dedupe. Derived keys are 64.
- The constructor refuses any host but `*.sandbox.paypal.com`, because live keys are out of scope for this repo.
- `approve_url` must be https on `*.paypal.com`, or it is null. A buyer gets sent there, and it's PayPal's text.
- Only code-shaped strings from PayPal are kept (`[A-Z][A-Z0-9_]*`, up to 64). The free text is dropped, so it never reaches the ledger.
- Every request has a 30 second timeout, so a hung connection can't hold up T2.

**`failure_code` stays executor vocabulary, not a reason code** (D-32). The new codes don't join the closed enum. The explanation of
a 403 lives in `describePayPalFailure`, because `ExecOutcome` has no detail field and adding one would touch every rail for one
message. The ledger has the code, and a person can look up the sentence.

**Rejected: PayPal's Agent Toolkit.** It gives a model tools that act on PayPal, which is what Praman exists to stand in front of.
`@paypal/agent-toolkit` is now in the boundary check's forbidden list.

**Capture tests use PayPal's documented sample,** from its OpenAPI schema, in a file that says so. Nothing in the repo claims a live capture.

**Limits.** Capture after approval is unverified. Three questions wait for a real approval: whether repeating a capture key returns the same capture,
whether a capture key that got a 422 before approval replays that 422 afterwards, and whether repeating a create after capture shows the order's
current status or the first answer. The third means a lost capture should be checked by order id, which `findOrder` supports and the reconciler
doesn't call yet (Task 7). `invoice_id` is the receipt, so if PayPal forgets a key after a capture, a repeat creates a new order that would
get `DUPLICATE_INVOICE_ID` at capture, which is the safe side.

### D-39 · A capture PayPal says is under way isn't a failed capture · Accepted

Status: "the capture has often finished by the time PayPal answers" is a guess, since PayPal doesn't say how long this takes and nothing has been captured live. The case for reading first is only that it can report a finished capture sooner. The table also leaves out a `VOIDED` order, which is reported as `failed`, `PAYPAL_ORDER_VOIDED`.

Status: the order is now read back after every capture refusal except `ORDER_NOT_APPROVED`, in `captureOrder`. See D-40.

Status: live captures have now run (D-49), so "live capture can't be exercised yet" no longer holds. Neither code here was seen, because every sandbox capture finished in its first answer. The evidence for both is still PayPal's documentation.

An implementer's decision for the builder to check, after a review found the bug in D-38. D-38 treated every named refusal on a
capture as "this capture took no money", with one exception, `ORDER_ALREADY_CAPTURED`. PayPal's Orders v2 error reference lists two
more 422s under capture that don't fit that reading:

| Code | PayPal's text |
|---|---|
| `ORDER_COMPLETION_IN_PROGRESS` | "PayPal is still in the process of capturing the order on your behalf as instructed. Please try your request again." |
| `AUTO_CAPTURE_ENABLED` | "This order is being auto-captured. Merchant initiated capture requests are not allowed." |

**What would have gone wrong.** Both came back as `failed`. T2 would append that and close the record. PayPal finishes the capture,
the buyer is charged, and no `captured` row exists. The reconciler only sweeps pending records, so nothing looks again. That is the
critical bug in invariant 5. No entrypoint calls this rail yet, so it was reachable only in tests and never ran against a real purchase.

**The decision.** These two are handled like `ORDER_ALREADY_CAPTURED`: `capture` reads the order and reports what it says.

| The order, read back | Reported as |
|---|---|
| `COMPLETED`, with a finished capture | `captured` |
| `COMPLETED`, with a `DECLINED` or `FAILED` capture | `failed`, `PAYPAL_CAPTURE_DECLINED` or `PAYPAL_CAPTURE_FAILED` |
| `COMPLETED`, with a `PENDING` capture | throw, record stays pending |
| `CREATED`, `PAYER_ACTION_REQUIRED`, `APPROVED` | throw, record stays pending |
| The read itself fails or is refused | throw, record stays pending |

**Rejected: throwing straight away.** It would also keep the record pending, but the capture has often finished by the time PayPal
answers, and reading says so now where a throw waits for the next look. Reading can't make things worse, since every answer short of
a finished capture still throws.

**What a `failed` capture means now.** PayPal named a code outside this list, and the code is read as "this capture took no money".
I read the rest of the capture section of the reference on 2026-11-05, and no other 422 there says a capture has happened or is under
way. `PREVIOUS_REQUEST_IN_PROGRESS` is the nearest. It is listed as a `RESOURCE_CONFLICT`, and a 409 already throws. A test now holds that.

**Limits.**

- The evidence is PayPal's documentation only. Live capture can't be exercised yet, so neither code has been seen.
- Text in the reference isn't a guarantee. A code PayPal adds later that means "under way" would still be read as `failed`. The other
  way to build this reads the order after every refusal on a capture, or lists the codes known to be safe. Either would close that gap,
  at the cost of an extra call on each refusal or a long list to keep. Not done here, and the builder may want it.
- The capture retry waits on Task 7. A record left pending this way needs the look-up by order id noted in D-38, or the reconciler
  will repeat the create instead of checking the capture.

### D-40 · Capturing and releasing a checkout order · Accepted

Status: section 9's "not captured" row is replaced. A pending capture whose order reads as not captured is now sent again under the same key, not recorded as failed. See D-41.

Status: the first item under "Unverified live" is settled by D-49: a capture key refused with 422 before approval captured normally after it. Decision 7's reliance on `ORDER_ALREADY_CAPTURED` was also seen live. The other two items are still unverified, and `captureOrder` itself has not yet run against a live approval.

Plan Task 7. An implementer's decisions for the builder to check. Two of them, what a failed capture leaves behind and reading
the order back after a refusal, were set as requirements in the Task 7 brief, and are recorded here so the reasoning sits next to
the code. None of this has run against a live PayPal capture yet. The last section says exactly what is unverified.

**1. A capture is its own outbox phase.** `idempotency_record` gains `kind` (`order` or `capture`), and on a capture record,
`order_key` and `order_id`. A check constraint refuses a capture record that names no order. `captureOrder` follows `runIntent`'s
shape (D-22): T1 takes the mandate lock, decides, and commits a pending capture record, a `capture_decision` and an `api_call`; the
rail call runs outside any transaction; T2 appends the outcome and settles the record.

**2. Every ledger row carries the order's key and order id.** The capture record has its own key, but the ledger never sees it as
`idempotency_key`. A capture outcome under its own key would fold as a second order and count the budget twice (D-30). It is kept
as `capture_key` instead. `order_id` is on every capture and release row, because one key can hold two orders (D-34).

**3. Capture decides from the record and the ledger, not from what the caller says.** `evaluateCapture` is frozen and trusts the
held amount it is given. So `captureOrder` finds the order through the intent rows this mandate wrote on the trace, requires a
settled order record and a `created` outcome for that order id, and takes the held amount from the ledger. If the ledger holds
two amounts for one order, it refuses rather than pick one. A repeat after a capture returns that capture and calls nothing.

**4. A `mismatch` order is never captured.** Even if the rail now quotes the authorised amount, it once answered with other money
(D-33). The refusal is `AMOUNT_CHANGED_SINCE_APPROVAL`, or `CURRENCY_MISMATCH` when the mismatch was in currency. No new code.

**5. Policy answers first.** `evaluateCapture` runs before the control plane's own checks (mismatch, the rail's currency, a rail
with no executor), so a revoked mandate says `MANDATE_REVOKED` whatever else is wrong. Refusals are `capture_decision` rows and
don't count toward the denial-rate cap (D-31). A caller with a bad signature changes nothing and is recorded as a claim (D-25).

**6. A definite capture failure moves no money, and the order stays live.**

| After a capture the rail definitely refused | |
|---|---|
| Budget | still held: the order exists and the buyer may still approve it |
| A retry | allowed, under a new capture record |
| The release sweep | may free it once 10 minutes pass, no capture is pending, and the rail confirms it isn't captured |

A failed outcome row changes nothing in `deriveState`, which already ignores `failed`. Releasing it straight away was rejected: the
commonest failure is a buyer who hasn't approved yet, and releasing would cancel a checkout that is still in progress.

**7. Each capture attempt gets a fresh derived key.** `captureRecordKey(orderKey, attempt)` is `sha256("capture|" + orderKey)` for
the first attempt and `sha256("capture|" + orderKey + "|" + n)` after that, where `n` counts the order key's earlier capture
records, read under the mandate lock. It stays derived and deterministic. It answers two problems at once: a retry can't collide
with the failed record's primary key (the P2002 shape fixed earlier for `runIntent`), and a retry doesn't reuse a `PayPal-Request-Id`
that PayPal may answer with the old 422 (D-38's open question).

The cost is that the key no longer dedupes a capture across attempts. That is acceptable because an order created with intent
`CAPTURE` can only be captured once: a second capture gets `ORDER_ALREADY_CAPTURED`, which `paypal-exec` reads back and reports
as the capture that happened (D-38). Within one attempt, the record and the mandate lock already stop a second call.

**8. Any refusal other than `ORDER_NOT_APPROVED` is read back before it is believed.** `ORDER_NOT_APPROVED` was seen live (D-26) and
is taken at its word. For every other refusal, `captureOrder` reads the order by id. If it shows a capture, that capture is
recorded. If the read throws, the record stays pending. This closes the gap D-39 left open, a code PayPal adds later that means
"under way", for one extra call on each refusal. The code is a constant in the control plane, so the control plane doesn't depend
on a rail, and a test pins it to `paypal-exec`'s.

**9. A capture record is reconciled by order id.** `reconcilePending` used to pass `order_id: null`, which on PayPal repeats the
create and says nothing about the capture. A capture record now reads its order by id:

| The order, read by id | Recorded |
|---|---|
| captured | the capture, under the order's key |
| failed, such as a declined capture | failed, with the rail's code |
| not captured | failed, `RECONCILE_NOT_CAPTURED`, hold kept |
| unknown to the rail | failed, `RECONCILE_ORDER_NOT_FOUND`, hold kept |
| the read throws | nothing, still pending |

It re-reads the record under the mandate lock, so a late T2 and the reconciler can't both write.

**10. The release sweep.** `releaseStaleOrders` only looks at rails in `CHECKOUT_RAILS`, which is `paypal`. Razorpay orders count
from creation (D-17) and are never released. An order is released when ten minutes have passed since its first outcome row, by
Praman's own clock, it has no capture, release or mismatch on the ledger, no capture of it is pending, and the rail says it isn't
captured. The ledger checks run again under the mandate lock before the row is written, so a capture that starts in between wins.
A rail that can't be asked, or doesn't know the order, leaves it held.

**11. A repeat of a released intent is `DUPLICATE_INTENT`.** D-30 said so, but `runIntent`'s idempotency short-circuit runs before
`evaluate()`, and it answered from the outbox record: a cached `ALLOW` with the dead order's checkout link. It now reads the
ledger for that order first. Released gives `DUPLICATE_INTENT`, written as a `decision` row like any other, so it counts toward the
denial-rate cap. Captured gives `captured` with no checkout link. `resolveApproval`'s repeat had the same bug and gets the same fix,
with no ledger row, as with its other refusals (D-36). The outbox record isn't changed: the ledger is the evidence, and one source
of truth is easier to reason about than two kept in step.

**12. The trace page and the dispute bundle read the last outcome.** Both read only the first outcome and reported `ALLOW`/`OK`
whenever one existed. Now the first outcome is the order and its amount, the last is where it stands, and a capture refused after
the last outcome is the answer, with its own reason code. A refusal recorded against an unproven claim changes nothing. A trace with
one outcome, which is every trace from before this task, reads the same as before.

**Rejected: refusing a capture of an order whose rail read says it is already captured.** Not done, and it is a limit: if the
ledger has no capture but the rail says captured, and the mandate has since been revoked, `evaluateCapture` refuses and the
capture that happened stays unrecorded. That can only come from a capture Praman didn't make. The release sweep logs it, and
PayPal webhooks (Task 9) are the place to record it.

**Unverified live.** No sandbox buyer approval has registered on PayPal's side, so no capture has ever run for real. Everything
above is tested against a stand-in rail in `packages/control-plane/test/support/checkout.ts`. Still unknown:

- whether a capture key that got a 422 before approval replays that 422 afterwards. Decision 7 means it doesn't matter to Praman.
- what reading an order by id returns while PayPal is still completing a capture. If it shows the order as not captured, the
  reconciler's 60 second gate would record a capture that is under way as failed. The hold is kept, a retry would get
  `ORDER_ALREADY_CAPTURED` and record it, and the sweep confirms with the rail before releasing. The window that remains is a
  release confirmed while PayPal is still completing, which webhooks (Task 9) close.
- how long `ORDER_COMPLETION_IN_PROGRESS` lasts.

**Limits.**

- The sweep re-reads every settled PayPal order record on each run, released ones included, since the record isn't changed. Fine
  at demo scale. A column marking settled orders would fix it.
- `api_call` rows for a capture carry the order's key, with `operation: "orders.capture"`. Task 8 pairs attempted calls with
  outcomes by key to reserve budget, and needs to tell a capture call from a create call by `operation`.
- Ten minutes is a judgement, as D-30 says. It is a constant, `ORDER_HOLD_TTL_MS`.

### D-41 · A pending capture is sent again, not guessed at · Accepted

Status: "Why the same key is safe" is confirmed live by D-49. A repeated capture key got 200 and the same capture, and a new key got `ORDER_ALREADY_CAPTURED`, which `paypal-exec` read back as that capture. What a capture still completing looks like is still unverified.

An implementer's decision for the builder to check, after a review of Task 7 found a money bug in D-40 section 9.

**The bug.** The reconciler read a pending capture's order by id, and if the order showed as approved but not captured, it
recorded the capture as failed with `RECONCILE_NOT_CAPTURED`. That read can't tell "no capture" from "a capture PayPal is still
completing", which D-39 counts as money possibly moving. Once the record was failed, nothing was pending, so the release sweep in
the same `pnpm reconcile` run could write `released`. If PayPal then finished the capture, the ledger read created, failed,
released, and the budget it spent was free to spend again. Nothing looks at a released order again.

**The decision.** When the read shows the order as not captured, the reconciler sends the same capture attempt again, with the
record's own derived key. It goes through `sendCapture`, the one function `captureOrder` uses too, so a refusal other than
`ORDER_NOT_APPROVED` is read back before it is believed.

| What the repeat gets | Recorded |
|---|---|
| a capture, new or the one already made | captured, under the order's key |
| `ORDER_NOT_APPROVED` | failed, with that code, hold kept |
| another refusal, and the read-back shows no capture | failed, with the rail's code, hold kept |
| no answer it can read, such as a capture still completing | nothing, still pending |

The other rows of D-40 section 9 are unchanged: an order read as captured or failed is recorded as such, an order the rail doesn't
know is failed with `RECONCILE_ORDER_NOT_FOUND`, and a read that throws leaves the record pending. A pending capture keeps the
release sweep away, as before.

**Why the same key is safe.** `PayPal-Request-Id` makes a repeat with the same key the same request. If PayPal no longer holds the
key, a capture that already happened answers `ORDER_ALREADY_CAPTURED`, which `paypal-exec` reads back and reports as the capture.
Either way the order can be captured once, since it was created with intent `CAPTURE`.

**What this changes.** A capture that never reached PayPal on an approved order used to be recorded as failed, and waited for the
buyer to retry. The reconciler now makes it. That capture was already decided in T1, under the mandate lock, and recorded as a
pending attempt with its amount; the reconciler finishes that attempt and doesn't decide a new one. It is the same shape as an order
record, which the reconciler settles by repeating the create with its key (D-26). The cost is that a mandate revoked between T1 and
the reconcile doesn't stop the repeat, just as it couldn't stop the first call had it arrived.

**Rejected: leaving the record pending while the order reads as approved.** It is safe for the money, but a capture that never
reached PayPal would stay pending for ever. That blocks every retry and the release sweep, so the order is stuck holding budget
until a person steps in.

**Still unverified live.** As with D-40, nothing has been captured on the sandbox. What a capture still completing looks like, and
how long it lasts, is from PayPal's documentation. Webhooks (Task 9) remain the backstop for a capture Praman didn't see finish.

### D-42 · Attempted calls reserve budget · Accepted

Status: D-44 corrects this record. "Never an overspend" didn't hold for Razorpay, whose calls had no timeout, and the "Still open"
paragraph missed the overspend before a late T2.

An implementer's decision for the builder to check. It follows the approved design's Concurrency section and `ROADMAP_PHASE2.md`
Phase 13, which set the direction. The details below were settled while building it.

**The gap, measured.** D-22 residual 2 said that between T1 and T2 a concurrent intent "can evaluate against a slightly understated
budget", and that "the window is one API call wide". `concurrent-spend.test.ts` was committed failing first (5bd6d7b) to see how big
it was. Twenty intents of 1,000 INR each, under one 5,000 INR mandate, were started at once with every rail call held until all
twenty had been decided. All twenty got `ALLOW` and all twenty orders were created: 20,000 INR against a 5,000 INR budget, four
times over. The same run also passed a velocity limit of 8 with 20 orders. Budget wasn't slightly understated. It wasn't counted at all
for anything in flight.

The window is also wider than one call:

| Case | How long an attempt went uncounted |
|---|---|
| The rail answers | one call. 8 PayPal sandbox creates on 2026-11-08 took 732 to 2036 ms, median 771 ms. The slowest was the first, which also fetched the OAuth token. |
| The call hangs | up to 30 s, `paypal-exec`'s request timeout, and then the case below |
| The call throws or the process dies before T2 | until a reconcile sweep settles the record. The sweep won't touch a record younger than 60 s, and only runs when someone runs `pnpm reconcile` |

So the last row had no upper bound at all.

**Decision.** `deriveState` counts an `api_call` with `status: "attempted"` and no outcome yet as reserved spend:

- It adds its `amount_minor` (or `amount_paise` on an old row) to `spent_minor`, and its time to `txn_timestamps`.
- It does **not** add the merchant to `merchants_transacted`. An attempt may not have made an order, so it shouldn't satisfy the
  first-merchant step-up.
- **Any outcome answers it,** `failed` included. A failed create made no order, so it frees the reservation, and a reconciled
  not-found is written as `failed` too. A `created`, `captured` or `mismatch` outcome takes over, and the order is then counted the
  way D-30, D-33 and D-34 already count it, once.
- **Pairing.** An `api_call` with an `idempotency_key` pairs only with outcomes carrying that key. Rows from before 2026-11-05 have no
  key on the `api_call` (F14), so they pair with any outcome on their `trace_id`. A key, when there is one, wins over the trace,
  because a trace comes from the intent id and two carts under one intent id share it. Old rows can't be rewritten, so the reader
  handles both shapes for good (D-28).
- **A capture's `api_call` reserves nothing.** It has `operation: "orders.capture"` and carries the order's key, and the order already
  holds its budget. Any other `operation`, including one this code doesn't know, reserves. An unknown kind of call might have made an
  order, so that fails closed.
- An unanswered attempt with a missing or malformed amount throws, the same as an outcome does. An answered one isn't read.

**Why fold it into `spent_minor` and not a new `reserved_minor` field.** It leaves `evaluate()` as it is, and the budget check is
meant to cover money that is committed or may be committed. D-17 already counts a created order on that principle. A separate field
would show the two apart, which is nicer to read, but needs `evaluate()` to add them, and `packages/policy` is frozen (D-31). The
cost is that `spent_minor` now means "spent or possibly spent". D-43 covers what this does to the freeze claim.

**Velocity moves once the outcome lands.** While reserved, the attempt's velocity timestamp is the `api_call` time. Once an outcome
arrives, the order's timestamp is the outcome's time, as before. For T2 those are the same moment. For a reconciled outcome it is the
sweep's time, which can be minutes later and holds the rate limit for slightly longer. That errs toward refusing.

**The reconciler takes the mandate lock (D-22 residual 4).** It reads `mandate_id` from the `intent` event, as it already did,
then takes the same advisory lock T1 and T2 take, re-reads the record, and writes only if it is still pending. Without that, a late
T2 and a sweep could both write an outcome for one call. Capture records already worked this way (D-41).

**Consequence, named.** A pending record nobody reconciles holds its budget and a velocity slot until a sweep settles it. That fails
closed: the worst case is a refusal, never an overspend. In production something has to schedule `pnpm reconcile`. Webhooks
(Task 9) can shorten the wait but don't replace the sweep, because a create that never reached the rail sends no webhook.

**After.** The same test passes: 5 orders created, the other 15 refused with `MANDATE_BUDGET_EXHAUSTED`. A second case with
budget for all twenty creates exactly 8, the velocity limit, and refuses 12 with `VELOCITY_EXCEEDED`.

**Rejected: a reservation table.** A stored counter is what D-03 avoids, and the ledger already has the attempt.

**Still open.** T2 doesn't check that its record is still pending before writing. If the sweep settled it first, T2 adds a second
outcome. With the same order id that counts once (D-34). If the sweep found nothing and T2 then reports an order, the order is counted,
which is right, because it exists.

### D-43 · What the policy freeze proves, and what it doesn't · Accepted

An implementer's decision for the builder to check, correcting D-31's wording.

D-31 ends with: "adding a currency took a small policy change, preparing for a checkout took another, and adding the rail itself
took none". `pnpm lint:policy-freeze` is the evidence offered for the last part. Here is what that check actually establishes.

**What it proves.** No file under `packages/policy` differs from commit `df81b87`, in what is committed or in the working tree, and
no untracked file has been added there. So the source of `evaluate()` and `evaluateCapture()` is byte for byte what it was before
`paypal-exec` existed. Since that package has no I/O and no LLM import (`pnpm lint:boundary`), the same inputs still give the same
decision.

**What it doesn't prove.** That `evaluate()` decides the same things for the same purchase. Its decisions depend on inputs built
outside the package:

- `LedgerDerivedState`, the type is in `@praman/shared` and the values come from `deriveState` in `packages/ledger`. Since the
  freeze, `deriveState` has changed in four commits under three decisions: holding budget for an order the rail misreports (D-33,
  `adf7519` and `19a5ee2`), counting two orders on one key as two (D-34, `c8fbc86`), and now counting attempted calls as spend (D-42,
  `4b34300`). Each one changes what `state.spent_minor`, `txn_timestamps` or `merchants_transacted`
  hold, and so which purchases `evaluate()` allows, with no line of `packages/policy` changing. D-42's change is deliberate: it is how
  concurrent intents stop overspending without touching `evaluate()`.
- `@praman/shared`, for the money helpers, `isCurrency` and the reason codes. It hasn't changed since the freeze (checked with
  `git diff df81b87 HEAD -- packages/shared`), but the freeze doesn't cover it, so nothing stops it changing.
- The catalog snapshot and the verified mandate, which the control plane builds.
- What happens after. `gateOnRail` in the control plane can turn an `ALLOW` into a denial (D-32). It can only narrow, never widen,
  but it is a policy-shaped decision outside the frozen package.

**The honest wording.** Adding the rail took no change to the policy engine's code. It did change the facts the engine is given:
how spend is counted from the ledger, and which merchants can be paid at all. Each of those changes has its own decision record and
tests, and none of them can widen what a signed mandate allows, but "policy unchanged" would claim more than that.

**Rejected: widening the freeze to `packages/ledger` and `packages/shared`.** It would have blocked D-33, D-34 and D-42, each of which
fixed a way to spend past a budget. Freezing the inputs would protect the claim and leave the bugs in.

### D-44 · A sweep must not act while a call can still be running · Accepted

Status: D-45 adds PayPal webhooks, and a late T2 now checks its record before writing a capture outcome. The Razorpay gap below stays open, since Razorpay webhooks are out of scope.

An implementer's decision for the builder to check. It corrects D-42, which a review showed claimed more than the code gave.

**What D-42 got wrong.** It said a reservation "fails closed: the worst case is a refusal, never an overspend", and its window table
gave a hung call "up to 30 s, `paypal-exec`'s request timeout". That was PayPal's bound only. Razorpay's `LiveExecutor` called
`fetch` with no signal, so a hung create could run for Node's default of about 300 s, while a sweep may act on a record once it is
60 s old (`RECONCILE_MIN_AGE_MS`). The reviewer reproduced the result with a held create on a 5,000 INR mandate and 1,000 INR items:

1. Intent A passes T1 and its create hangs.
2. A sweep runs after 60 s, finds no order for A's receipt, writes `failed`, and frees A's 1,000 INR.
3. Intents B to F each get `ALLOW` and create orders.
4. A's create returns. T2 appends `created`, and the order counts again.

`spent_minor` ends at 6,000 INR against 5,000. D-42's "Still open" paragraph called step 4 right, since the order exists, and
didn't mention step 3. The gap goes back to D-22 residual 1. D-42 didn't create it, but its wording hid it.

**Decision.** Every live rail call gives up well before a sweep may touch its record.

- `LiveExecutor` now aborts any call, body read included, after `RAZORPAY_REQUEST_TIMEOUT_MS`, 30 s (`f532d2e`). A timeout is an
  unknown outcome, so `runIntent` leaves the record pending, as it does for any throw.
- `rail-timeouts.test.ts` checks that both rails' timeouts are at most half of `RECONCILE_MIN_AGE_MS` (`0cf49a2`). Half leaves room
  for T1's commit and for T2 waiting on the mandate lock. A timeout raised on one rail now fails a test.

So by the time a record is old enough to sweep, the call that made it has returned and T2 has run, or the call threw and nothing
else will answer it. The sweep and a live call don't overlap.

**What still isn't closed, per rail.**

- **Razorpay.** A client that gives up doesn't stop the server. Razorpay can finish a create after the 30 s abort, and its lookup by
  receipt lagged creation by over 15 s when measured (D-22). A sweep at 60 s can then miss an order that exists, write `failed`,
  and free its budget, with no T2 left to count the order. That is an overspend of up to one order per such call, until something
  reads the order back. Nothing does today. Webhooks (Task 9) would. Waiting longer before a sweep makes it rarer and doesn't end it.
- **PayPal.** The sweep repeats the create with the same `PayPal-Request-Id` (D-26). PayPal either returns the order it already made
  or makes it now, so the sweep doesn't report "no order" for one that exists. The timeout bound is what this rail needs.
- **Both.** A T2 delayed past the bound, by a paused process or a long lock wait, can still arrive after a sweep. T2 still doesn't
  check that its record is pending. When it isn't, its outcome is appended anyway, which counts an order that exists, and is right.
  The overspend is in what was allowed between the sweep and that T2.
- The test doubles, `LatchedExecutor` and `SimulatedExecutor`, have no timeout. They aren't live rails, and the reviewer's case
  with a latch held past 60 s still overspends. The bound belongs to each live executor, not to the `Executor` interface.

**The honest wording.** A pending reservation fails closed while it is pending. A sweep that wrongly writes `failed` releases it,
and on Razorpay that can still happen for a create the server finished after the client stopped waiting.

**Rejected: a deadline in `runIntent` around the call.** Dropping a late answer doesn't stop the request, so the order can still be
made, and an answer that arrives would be thrown away instead of counted. Each executor can abort its own request. `runIntent` can't.

**Rejected: raising `RECONCILE_MIN_AGE_MS`.** It holds budget longer on every failed call and doesn't close the Razorpay case,
which needs a read of the order after the fact, not a longer wait before it.

### D-45 · Webhooks speed up reconciliation, the sweep stays · Accepted

Status: the "declined, capture call pending" row is replaced. A declined webhook now writes a settlement row only and leaves the record pending. See D-46.

An implementer's decision for the builder to check, made in plan Task 9 on 2026-11-08.

**Not yet seen live.** No PayPal webhook has reached this project, because nothing is hosted for PayPal to send to. Everything
below is tested against synthetic events written from PayPal's published schemas (`packages/paypal-exec/test/fixtures/README.md`
names the sources), with PayPal's verification answer stood in by a fake. A test with a real sandbox delivery is owed once the app
is hosted.

**What a webhook may do.** `POST /webhooks/paypal` acts on two events, `PAYMENT.CAPTURE.COMPLETED` and `PAYMENT.CAPTURE.DECLINED`.
Every other type is answered 200 and ignored. For the two it acts on:

1. **Verify first, over the exact bytes.** The handler sends the delivery to PayPal's `verify-webhook-signature` with the body
   spliced in as `webhook_event`, byte for byte, and acts only on `SUCCESS`. PayPal's webhook guide warns that a parsed and
   re-serialised body can fail to verify. One check runs before that: the body must be a single JSON object, or splicing it could
   add keys of its own, such as a second `webhook_id` pointing at someone else's webhook.
2. **Keep ids, not text.** The parser keeps the event id, the capture id, the order id from `supplementary_data.related_ids`, the
   amount through `fromPayPalValue`, and a known currency, each against a narrow pattern. The summary, `custom_id` and notes are
   never read, so PayPal's text can't reach the ledger, a page or a prompt (invariant 7).
3. **Find the order on the ledger.** By order id, on the `created` or `mismatch` rows for that rail, and by the invoice id if
   PayPal echoes one, since Praman sets it to the order's receipt. No match is logged and writes nothing.
4. **Write under the mandate lock.** One `settlement` row per piece of news, deduplicated on the event id and on the payment id
   with its status. The settlement row moves no money (D-31). When it tells the ledger something new, an `outcome` follows:

| Webhook | Ledger before | Appended | Capture record |
|---|---|---|---|
| completed | capture already recorded | settlement only | none left pending |
| completed | capture call still out, or its answer lost | settlement, then `captured` | resolved as succeeded |
| completed | order released, no capture recorded | settlement, then `captured` | none |
| completed, other money | no capture recorded | settlement, then `mismatch` (D-33) | resolved as succeeded |
| declined | capture call pending | settlement, then `failed`, `PAYPAL_CAPTURE_DECLINED` | resolved as failed, hold kept |
| declined | no pending capture | settlement only | none |

**A late capture T2 now checks its record.** If a webhook resolved the capture record while Praman's own call was out,
`captureOrder`'s T2 finds it no longer pending, writes nothing, and returns what was recorded. Before this it appended regardless,
which D-44 called acceptable for an order. For a capture it would have been a second `captured` row about one payment. The
reconciler already checked (D-42). `runIntent`'s T2, for creates, is unchanged, since no webhook resolves an order record.

**Answers to PayPal.** Forged or unverifiable gets 400 and nothing is written. PayPal unreachable, or this app unable to
authenticate, gets 503, and recording failing gets 500, so PayPal delivers again. A verified event, applied or not, gets 200. No
reply carries an error message.

**Why the sweep stays.** A webhook can be late, lost, or never sent, and PayPal's retries end after a few days. So
`reconcilePending` and `releaseStaleOrders` still decide every record a webhook doesn't. A webhook only ever moves a record from
pending to resolved, and only with PayPal's signed word on what happened.

**What it closes.** P7 left open a capture PayPal made that the ledger never recorded, such as one on an order Praman had released.
A completed webhook now records it, and its budget counts again, because a capture beats a release (D-30). D-44's Razorpay gap is
**not** closed: Razorpay webhooks are out of scope (design, "Webhooks"), so a create Razorpay finished after the client gave up
still has nothing reading it back.

**Rejected: verifying locally with the certificate.** PayPal documents a local check (CRC32 of the body, then SHA256withRSA against
the certificate at `paypal-cert-url`). Done properly it means fetching and caching that certificate and validating its chain to a
trusted root. The postback asks PayPal to do all of that, at the cost of one call per delivery and a dependency on PayPal being up,
which the 503 retry covers.

**Rejected: letting the settlement row itself count.** `deriveState` would have to read a second event type for money, and a test
already pins that a settlement moves nothing on its own. An `outcome` row, written by actor `webhook`, keeps one place where money
is counted.

**Limits.** Synthetic events only, as above. Dedupe by payment and status assumes PayPal never sends two different captures with the
same id. The handler holds a 64 KiB body limit, which PayPal's documented events are far under.

### D-46 · A declined webhook can't close a capture attempt · Accepted

Status: what "Still unverified live" relies on is confirmed by D-49. PayPal answered a repeated capture key with the first capture. No real webhook, declined or completed, has been delivered yet.

An implementer's decision for the builder to check, made on 2026-11-08 after a review of plan Task 9 found a money bug in D-45.

**What D-45 got wrong.** D-45 let a `PAYMENT.CAPTURE.DECLINED` webhook resolve whatever capture record was pending on the order,
as `failed`. A decline names a capture id and an order, never the attempt it answers, and D-40 lets an order be captured again after
a refusal. So a decline of attempt 1 that arrives late, or is delivered again after an earlier 503, could close attempt 2. The
reviewer reproduced it, and the test in `eedaf27` does the same:

1. Attempt 1 is refused with `INSTRUMENT_DECLINED`. T2 records `failed`.
2. Attempt 2 passes T1 and its call is held before T2.
3. Attempt 1's decline arrives. `applySettlement` writes `failed` and marks attempt 2's record failed.
4. Attempt 2's capture succeeds at PayPal. Its T2 finds the record resolved (`c0bb114`) and writes nothing.

PayPal holds the money, the ledger ends `created, failed, failed`, and the record is closed, so `reconcilePending` never looks at it.
Only a completed webhook would correct it, and if that one is lost nothing does.

**The change.** A declined webhook writes its `settlement` row and nothing else. A pending capture record is left to its own T2, or
to the sweep, which sends that attempt again under its own key (D-41) and so gets PayPal's answer for that attempt. A decline moved
no money, and a failed capture keeps the order's hold anyway, so leaving the record pending costs no budget. It costs time: a
capture whose call was lost now reads `IN_FLIGHT` until the sweep runs, where before a decline could close it early.

A completed webhook still resolves a pending record. An order is captured at most once, so a completed capture is the answer to
every attempt on it.

| Webhook | Ledger before | Appended | Capture record |
|---|---|---|---|
| declined | any | settlement only | unchanged; T2 or the sweep resolves a pending one |

The other rows of D-45's table are unchanged.

**Rejected: reading the order at the rail before closing the record.** A read can't tie a decline to an attempt either. In the
reviewer's case attempt 2's call hasn't reached PayPal yet, so the order reads as not captured, and the read would agree with
closing it.

**Rejected: comparing the event's time with the record's.** A redelivery keeps the event's original time, which would help, but
PayPal's clock and ours can differ by more than the gap between a refusal and a retry, and an attempt's own decline can be stamped
close to its record's creation.

**Still unverified live.** The sweep's resend relies on PayPal answering a repeated `PayPal-Request-Id` with the first answer, as D-41
already does. No capture has been made on the sandbox yet.

### D-47 · Langfuse is a lens, the ledger is the record · Accepted

Drafted as Appendix A of `docs/ROADMAP_PHASE2.md` and revised on 2026-11-08 to match what was built. The hosting default, the
3-second flush limit and the score ids are an implementer's choices for the builder to check.

**Decision.** Langfuse traces the buyer agent's model calls, tool calls and eval runs so a developer can look at them. It is not
evidence, it has no part in authorisation, and nothing in Praman reads data back out of it.

**Why two systems, not one.** They answer different questions for different people.

| | Ledger | Langfuse |
|---|---|---|
| Question it answers | Was this money action authorised, and can that be shown later? | Why did the model propose this, and where did the time and tokens go? |
| Who reads it | Dispute officer, auditor, risk team | Developer debugging or tuning the agent |
| Can it change | No. Append-only triggers on `ledger_entry` | Yes. Traces can be edited, deleted and expired |
| Is it complete | Every intent has its decision, and every call attempt is written before the call (D-22, D-42) | No. Export is best effort and in batches, and drops data when the host is down |
| Can a reader check it | Hash chain and Merkle checkpoints, checked by `pnpm verify-ledger`. Roots are not anchored outside yet | No |
| Who runs it | Us, inside the trust boundary | A separate service, by default a third party |

A system with Langfuse's properties can't carry the ledger's guarantees, and filling a tamper-evident record with debugging
telemetry would make it bigger without making it more trustworthy.

**Rules, and what holds each one.**

1. Authority flows one way. The control plane writes the ledger. Instrumentation copies agent-side activity to Langfuse. No
   decision, prompt, reported metric or verification reads from Langfuse.
2. Langfuse starts only in entrypoints: `apps/buyer-agent/src/demo.ts`, `apps/eval/src/cli.ts` and `apps/eval/src/ablation-cli.ts`,
   through `startTracing()` in `apps/buyer-agent/src/tracing.ts`. `pnpm lint:boundary` fails if `packages/policy`, `ledger`,
   `exec-core`, `razorpay-exec` or `paypal-exec` imports `@langfuse/` or `@opentelemetry/`.
3. If an audit could need a fact, it goes in the ledger even when Langfuse also has it. The system prompt's sha256 and the ablation
   flags are on the `agent_transcript` row for that reason (`864105a`).
4. The ledger may hold a pointer to a Langfuse trace, `observability.langfuse_trace_id` on `agent_transcript`, and it is marked
   non-evidentiary. It asserts nothing. A broken pointer changes nothing in verification.
5. Losing Langfuse is harmless. With no keys nothing starts. With a host that refuses connections or never answers, the run writes
   the same ledger rows in the same order, and stopping waits 3 seconds at most before the process exits. Tests in
   `apps/eval/test/tracing-inert.test.ts` (`7b77b16`) check all three cases against the demo's own path.
6. Mandate limits don't go to Langfuse. The `run-intent` span's output is the agent-visible decision plus the reason code, never
   `Decision.detail`, which quotes limits.
7. Langfuse data never goes back into a prompt. It holds injected merchant text, the same reason `agent_transcript` is evidence and
   never context.
8. Numbers in the report are computed here. Token spend is summed from each provider response's own `usage` (`d2b563d`). The
   `influenced` and `money_moved` scores sent to Langfuse are copies of the runner's result (`0f420bc`), sent under a fixed id per
   trace so a resend updates rather than duplicates.

**Hosting.** The code defaults to Langfuse Cloud (`LANGFUSE_BASE_URL` in `.env.example`). Self-hosting needs only that variable
changed. No compose file for it was added. With keys set, these leave the machine: the system prompt, every model input and output
(merchant text included, inside its delimiters), tool results, the proposed cart and its rationale, the intent, the agent-visible
decision and reason code, token counts, `praman_trace_id`, eval tags (case id, arm, repeat, git SHA) and the two scores. Mandate
limits, `Decision.detail` and keys do not. Test mode makes this acceptable. Traces are not linked from anything public.

**Rejected.**

- *Langfuse as the audit trail.* It can't be checked or shown complete, and it can change. It fails every row in the ledger column.
- *Prompt Management at runtime.* The defence prompt is a security control. Served from a store that can change without a commit or
  review, a trace's provenance would depend on that store's history. Prompts stay in git.
- *LLM-as-judge scores on reported numbers.* D-02's objection holds: a scorer that isn't deterministic can't be regression-tested,
  and it would send injected merchant text to one more model. `influenced` stays a set comparison.
- *Spans inside the money-path packages.* The boundary check forbids it.

**Not built.** The Langfuse `mask` hook as a second guard on rule 6. Spans inside `packages/control-plane`, the roadmap's stretch
item. The eval entrypoints don't wrap their provider in `TracedProvider`, so eval traces show tool calls and tags but no model calls.

**Consequence.** Two systems record overlapping activity, and a reader has to know which one to trust for what. The README's
"Observability vs evidence" section says which.

### D-48 · How the eval counts runs on two rails, and how sure it is · Accepted

An implementer's decision, made while doing Task 11, for the builder to check. The plan asked for intervals, the Fisher test, and
the same Layer 1 cases on both rails. It didn't say how a case that runs twice should be counted.

**Decision.** Each Layer 1 case runs once as written, at a merchant on the rail its currency belongs to: INR on Razorpay, USD on
PayPal, the same pairing `pnpm seed-catalog` uses, because PayPal's sandbox refuses INR (D-26). A case with one currency throughout
and a v2 mandate then runs again with every currency relabelled, at a merchant on the other rail. The integers stay the same, so a
₹180.00 item becomes a $180.00 item and every limit moves with it. Both runs use the simulated executor.

The headline rates, money at risk prevented and latency count each case once, as written. A mirrored run is reported in its own
"Both rails" section, as a count of runs that got the same outcome and reason code as the original. A mirrored run that fails still
fails the eval and appears under unresolved exceptions.

**Why mirrored runs stay out of the headline.** A mirrored run is the same case again, not a new sample. Counting it would double n
and make every interval look about 30% narrower than the evidence supports. Its amount is also not money anyone risked: adding the
relabelled amounts would have added an invented $21,598.00 to the ₹21,610.50 and $30.00 actually prevented.

**Why some cases aren't mirrored.** Relabelling every currency in a case that tests two currencies against each other would erase
what it tests. A v1 mandate can only be in INR, so moving it to USD would mean rewriting it as v2, which is a different case. An
unsupported currency (JPY) has no rail. Four cases run on one rail for these reasons, and the report names each one.

**Intervals.** Every rate prints k/n and a 95% Wilson interval. Wilson rather than the normal approximation, which gives 0% to 0%
for 0 of 21 and so claims certainty a sample of 21 can't give; Wilson gives 0% to 15.5%. The ablation compares its arms with a
two-sided Fisher exact test, which is exact at these counts where a chi-squared test is not. On 2/21 against 0/21 it gives
p = 0.49, and the report and README say plainly that the gap is within chance.

**What the mirrored runs show, and what they don't.** That the merchant's rail changes nothing in what Praman decides, for these
cases. Nothing in `evaluate()` reads the rail, and `gateOnRail` only checks the merchant's currency and that an executor exists, so
this is the expected answer; the runs are a regression check that keeps it true. They don't show that either rail's API behaves,
since no rail is called.

**Rejected.**

- *Pool both rails into the headline rates.* Narrower intervals from repeated cases, and a dollar total that was never at risk.
- *A second, hand-written USD corpus.* Forty-two new fixtures would drift from the INR ones. Relabelling keeps the two runs of a
  case identical except for currency and rail, which is the one thing being checked.
- *Rerunning Layer 2 to refresh its figures.* It calls a paid model. The README and report instead label the Layer 2 figures as
  recorded on 2026-09-05, before the catalog line the model reads changed on 2026-11-05.

### D-49 · What a live PayPal capture does in the sandbox · Accepted

Status: decision 4 is built. A no-buyer charge now goes through `runIntent` or `resolveApproval` and `acceptOutcome`, and seven ran live on 2026-11-08 through the demo's own code. `captureOrder` after a live approval is still unverified. See D-50.

An implementer's record for the builder to check. It moves D-26, D-37 and D-38 forward with live sandbox runs from 2026-11-08,
made with throwaway scripts outside the repo and buyer approvals clicked by hand in a browser. Nothing in the repo changed because
of them: each answer matches what the code already assumed, and the section after the tables says where.

**Captures, checkout orders.**

| Question | Observed |
|---|---|
| Capture an approved order | 201, order `COMPLETED`, one capture `COMPLETED` for $15.00, with a capture id |
| The same capture again, same `PayPal-Request-Id` | **200 and the same capture id.** No second capture. |
| Capture again with a new key | 422 `ORDER_ALREADY_CAPTURED`. A GET of the order then shows `COMPLETED` with that one capture. |
| Capture before approval, then the same key after approval | first 422 `ORDER_NOT_APPROVED`, then **201 `COMPLETED`** under the same key. The refusal is not replayed. |

The last row was run once, on a $2.00 order. A $3.00 order approved in the same run was captured beside it and also gave 201
`COMPLETED`.

**Saved payment method, no buyer present.**

| Question | Observed |
|---|---|
| Payment token from a setup token the buyer approved | 201, with a customer |
| An order with `payment_source.paypal.vault_id` and intent `CAPTURE` | **201, order `COMPLETED`, already captured** ($4.00). No approval step and no capture call. |
| The same create, same key | 200, the same capture |
| The same key, $9.00 instead of $4.00 | **200 and the original $4.00 capture,** with no error |

**Read back through `paypal-exec`.** The rows above came from scripts that called PayPal directly. Afterwards I looked up the order
behind each of the four captures (`GET /v2/payments/captures/{id}` names it) and ran `PayPalExecutor` against them. `findOrder` by
id reported `captured` with PayPal's capture id and amount for all four, the no-buyer order included. `capture` with a fresh key got
`ORDER_ALREADY_CAPTURED` on each, read the order back, and reported that same capture. So D-38's read-back has now run against real
captured orders, not only against the documented sample in `documented-shapes.ts`.

**Sandbox accounts.**

- The seller is an India Business sandbox account, the app's default. It accepts USD orders.
- An India Personal buyer can't pay it. A USD order showed "This seller doesn't accept payments in your currency", and the vault
  approval page showed "Things don't appear to be working".
- A US Personal buyer approves checkout orders and setup tokens. That is the demo buyer.
- A second checkout in the same browser session was sometimes declined before any click, with "To comply with international
  regulations, this transaction has been declined". The same order then approved in a fresh browser session. A control order with
  no early capture attempt did the same, so this is a sandbox risk check tied to the session, not something the early
  capture caused.

**What each result means for the code.**

1. **The sweep's resend is safe, as D-41 and D-46 assumed.** A repeated capture key returns the first capture with 200, and a new
   key gets `ORDER_ALREADY_CAPTURED`, which `paypal-exec` reads back as the capture that happened. Either way one order gives one
   capture.
2. **D-40's per-attempt capture keys stay.** They were partly a hedge against PayPal replaying a 422 to a reused key, and PayPal
   doesn't. The other reason still holds: a retry must not hit the failed record's primary key. Nothing changes.
3. **A no-buyer charge works in this sandbox, so plan Task 14 no longer waits on PayPal.** The vault feature on the app (D-37) and
   one buyer approval of a setup token are all it took. Whether to build Task 14 is still the plan's call, and it is first to cut.
4. **Task 14 must send the no-buyer answer through `acceptOutcome`.** The $9.00 row is D-26's silent reuse again, but this time the
   money has already moved at the old amount. `acceptOutcome` already turns a `captured` answer at other money into a `mismatch`,
   which holds budget (D-33). A no-buyer path that skipped it would record $9.00 against a $4.00 charge, or the reverse.
5. **The demo uses a US Personal buyer and a fresh browser session for each checkout,** and the judge instructions say so. This is
   advice for Tasks 12 and 15, not code.

**Rejected: going back to one capture key per order,** now that PayPal doesn't replay a refused key. A retry would collide with
the failed record's primary key again, and nothing is gained.

**Not done: a live capture test in `pnpm test`.** A new capture needs a buyer to click through PayPal's checkout, so it can't run
unattended. A test that reads the four captured orders back could, but it would depend on sandbox data that only this account has
and PayPal may expire. That is the builder's call. `live.test.ts` stays as it is, creating and reading unapproved orders.

**Still unverified live.**

- A real webhook delivery. Nothing is hosted, so PayPal has had nowhere to send one (D-45).
- What a GET of an order shows while a capture is still completing, and how long `ORDER_COMPLETION_IN_PROGRESS` lasts (D-40, D-41).
  Every capture here finished in its first answer, so neither was seen, and neither was `AUTO_CAPTURE_ENABLED`.
- D-38's third question: whether repeating a checkout order's create after it was captured shows the order as it is now or as first
  created. Not tried. The reconciler reads a capture record's order by id (D-40), so it doesn't depend on the answer.
- Praman's own `captureOrder`, end to end, after a live approval. The control plane has only captured on its stand-in rail. The
  demo (Task 12) is the first place it will.
- How long PayPal keeps a key. Direct card wasn't re-tested, so D-26's 422 stands.

**Limits.** One app on one sandbox account, on one day, and most rows were run once. Sandbox risk checks and live ones differ, and
live keys stay out of scope for this repo.

### D-50 · Who decides whether the buyer is at PayPal · Accepted

Status: the rule below is unchanged, but the table is only what happens when the model asks for what each goal says. Any of the three steps becomes a checkout when its cart reaches the threshold, and the demo now handles that on every step (D-52). On a graceful shutdown the saved payment tokens are now deleted at PayPal too; a crash still loses them in memory while PayPal keeps them (D-54).

An implementer's decision for the builder to check, made in plan Tasks 12 and 14 on 2026-11-08. The builder's brief set the
requirements: the rail stays server config, the choice must not come from the model or a request, the payment token is a secret,
and a no-buyer charge goes through the outbox like any other.

The demo merchant is on the PayPal rail, and an order on it can be paid two ways. A checkout order waits for the buyer to approve
it at PayPal, then Praman captures it (D-40). A charge from a saved payment method names the buyer's vault id and PayPal captures
it as it creates it, with no buyer present (D-49). Something has to pick one for each order.

**Decision: an order below the signed mandate's approval threshold is charged to the session's saved method, if it has one.
At or above the threshold, or with no saved method, it is a checkout order.** `savedMethodChoice` in the demo decides, from two
things only: the amount T1 authorised from the catalog, and the threshold in the mandate the server signed. Nothing in the intent
or the request reaches it. In the story that gives:

| Step | Praman's decision | Amount | Paid by |
|---|---|---|---|
| First purchase | `STEP_UP_FIRST_MERCHANT`, then you approve | $12.50 | saved method, no buyer |
| Second purchase | `ALLOW` | $4.50 | saved method, no buyer |
| Large purchase | `STEP_UP_THRESHOLD`, then you approve | $32.00 | PayPal checkout, then a re-checked capture |

The reasoning is that the threshold already means "a person should look at this". A purchase that big gets the person twice:
once in Praman's approval, and once as the buyer at PayPal.

**How it is built.**

- `PayPalExecutor.chargeSavedMethod` sends `payment_source.paypal.vault_id` with intent `CAPTURE`, the derived key as
  `PayPal-Request-Id`, and the receipt as `invoice_id`, and reads the answer with the same code as every other order.
- `SavedMethodExecutor` wraps it and is the `paypal` executor for one session. Its `createOrder` asks the choice function, and
  either charges or makes a checkout order. So the charge is one `createOrder` call inside `runIntent` or `resolveApproval`: T1
  writes the outbox record and `api_call`, the call runs outside any transaction, and T2 appends one outcome, `captured`. No
  capture phase, no capture record.
- The answer goes through `acceptOutcome`. D-49's $9.00 row showed a reused key answered with an old $4.00 charge, and here money
  has already moved, so a different amount or currency is a `mismatch` that holds the authorised amount (D-33). A test pins it.
- A lookup with no order id repeats the create as a checkout order, never as a charge. If PayPal has forgotten the key, a
  repeated charge could take the money twice, while a new checkout order moves nothing until a buyer approves it (D-26).
- The router is built per request from the visitor's session, so the only saved method an executor can reach is that session's.

**The payment token.** Anyone holding it with this app's credentials can charge the buyer. It lives in `SavedMethods`, a map in
server memory keyed by session id, apart from the session object so nothing that renders or serialises a session can reach it. It
is never logged, never on the ledger or the outbox, never in an approval, never sent to the page or the model, and its `toJSON`
prints a placeholder. When a session ends or expires the token is removed and deleted at PayPal. A test runs the whole story and
checks every response, ledger row, record and log line for it.

**Rejected: two merchants, one per mode.** It would make the mode server config with no new code, but the story needs one
merchant: the second purchase is `ALLOW` only because the first one at the same merchant succeeded (step 17 of `evaluate()`).

**Rejected: choosing by reason code.** `STEP_UP_THRESHOLD` against `STEP_UP_FIRST_MERCHANT` would also work, but the executor
only sees the amount, and passing a decision down into a rail would let a rail depend on policy vocabulary. The amount and the
signed threshold give the same answer without that.

**Rejected: keeping the token in the database.** It would survive a restart, and it would be a long-lived credential in a table
with backups. An hour of a visitor's session doesn't need it.

**What this is not.** It isn't a policy rule. `evaluate()` still decides whether money may move, and this only picks how, after an
`ALLOW` or an approved `STEP_UP`. It can't widen anything, since both ways need Praman's decision first. `packages/policy` is
unchanged and `pnpm lint:policy-freeze` passes.

**Live.** On 2026-11-08 the demo's own code charged the sandbox through `runIntent` and `resolveApproval` with the payment token
the builder approved during the D-49 runs: $12.50 after an approval and $4.50 on an `ALLOW`, each one `captured` outcome on the
ledger with no token in any row. Seven such charges ran across four runs, the last two being the screenshot runs. A $32.00 order became a checkout order with the demo's return pages,
and a capture before approval got `ORDER_NOT_APPROVED`. The connect flow made a real setup token and approve link. What hasn't run:
a buyer approving that connect flow in the demo, and `captureOrder` after a buyer approves the demo's checkout. Those need a person
at PayPal's login.

### D-51 · The demo has no inputs · Accepted

Status: two parts below were wrong, and both are fixed (BUILD_LOG, P12 review fix). "A double click can't make a second purchase" did not hold when a step threw after its charge; a step is now recorded before Praman is asked (`8359a32`). The checkout link now goes to a different browser, not a new private window, since private windows of one browser share one PayPal session (`c2c5471`).

Status: the checkout advice changed again (`141d245`). What matters is a PayPal session that hasn't logged in, so the page now says: a window that is not logged in to PayPal, which is a private window if the demo is in a normal one, otherwise another browser. "Each step runs once" now holds only for a step that charged or may have: a refused step can be asked again (D-52). The checkout return page now sends visitors back to their demo window, not their demo browser.

Status: Task 13 added the daily caps and the recorded fallback that the "model calls are capped per session" line promised, and a per-session limit on button presses (D-57). On the hosted server a restart can come at any time, not only on a deploy, and it ends every session as this record says (D-55).

An implementer's decision for the builder to check, made in plan Task 12 on 2026-11-08. The design said there is no public
intent API and no free-text goal. This record says how the demo's routes make that hold.

**Decision: a visitor is a session cookie, and every route acts on that session's own things and nothing else. No route reads a
request body. The one query value read is PayPal's `approval_token_id` on the way back from connecting, and it must equal the
setup token the server stored for that session.**

So a request can't name a price, currency, rail, merchant, goal, approval, trace or token. `POST /demo/approve/first` approves
the step-up that this session's first step made, found by the approval id kept in server memory. `POST /demo/capture/large`
captures this session's large purchase. A second visitor posting the same paths with another visitor's ids in the body or the
query changes nothing, and a test does exactly that.

- **Sessions are in memory,** with a one-hour life. The mandate's validity is the same hour. A restart ends every session, and
  the ledger keeps everything they did.
- **Each session gets two mandates,** signed with `DEMO_MANDATE_PRIVATE_KEY`: the story's, and a separate one for the
  concurrency harness so twenty test intents can't spend the story's budget. The demo refuses to start if that key is the local
  `MANDATE_PRIVATE_KEY`.
- **Each step runs once.** A step that already ran is shown again, not run again, and a session runs one step at a time. A double
  click can't make a second purchase.
- **Cross-site posts are refused.** The cookie is `SameSite=Lax` and `HttpOnly`, and a POST whose `Origin` isn't the demo's own
  gets 403.
- **Model calls are capped per session** at 40. Task 13 adds the daily cap and the recorded fallback.
- **Errors show a plain page.** The operator log gets the error's name and message; the visitor gets neither.

**The checkout return page knows nothing.** PayPal's sandbox can decline a second checkout in the same browser session (D-49), so
the page tells visitors to open the checkout link in a new private window. That window has no cookie. So the return page does
nothing and tells the visitor to go back to their tab and press capture.

**Rejected: an approval link with the approval id in it.** It is what `pnpm approve` takes, and anyone who saw the link could
approve. D-36 left that open for a public endpoint.

**Rejected: storing sessions in Postgres.** It would survive restarts and needs a migration and a sweep for a demo that lasts an
hour. Revisit if the host runs more than one instance.

### D-52 · Each demo step buys at its own shop, and no step can strand the story · Accepted

An implementer's decision for the builder to check, made on 2026-11-08 to fix review findings on plan Tasks 12 and 14. The
builder set the rules: no LLM in the money path, the price from the catalog, and a story that never gets stuck.

**What was wrong.** The intent's `merchant_id` came from the model's cart. The visitor's mandate allows two shops, the cafe and
the market, so a cart the model pointed at the market in a cafe step would be a real purchase there, and Praman would allow it.
And only step 5 could be approved or captured. If the model asked for two bowls in step 3, $25.00, that step became a checkout
with no capture button, and steps 4 and 5 waited on it for good. A refused or rejected step ended the story the same way.

**Decision 1: the server's merchant goes in the intent, and the cart must name it.** `GOALS` already fixes each step's merchant.
`checkCart` in `story.ts` refuses a cart that names any other merchant, or whose line items aren't SKUs with whole positive
quantities, before Praman is asked. The step says so in plain words and nothing is charged. Nothing goes on the ledger either:
no intent was made, so there is nothing to record. The price is still the catalog's and the decision is still `evaluate()`'s.
This only decides whether to ask.

**Decision 2: every purchase step can be approved, can become a checkout, and can be captured.** The routes take
`/demo/approve/{first,second,large}` and `/demo/capture/{first,second,large}`, each acting on this session's own step, and the
page shows the PayPal link and the capture button on whichever step has a checkout waiting.

**Decision 3: a step can be asked again only if nothing can have been charged for it.** That is a step the model proposed
nothing for, or one that was refused: by Praman, by the visitor, or before Praman was asked. Asking again makes a new intent with
a new key, which is only safe because the old one charged nothing. A step that paid, failed at the provider, or is pending is
shown and never run again, as the retry fix in P12 requires.

**Rejected: keeping step 3 below the threshold by its goal alone.** The goal already says "one". The model can still ask for two,
and the page must not depend on it not doing so.

**Rejected: sending the model's merchant to Praman and letting policy refuse it.** It wouldn't refuse: both shops are in the
mandate's scope. The step is what is out of scope, and that is the demo's knowledge, not the mandate's.

**Rejected: recording the refused cart on the ledger.** That needs an intent and a decision, and a new reason code for "the cart
named the wrong shop" (invariant 8), with `packages/policy` frozen. The step's page says what happened.

### D-53 · How a trace says who paid and who approved · Accepted

An implementer's decision for the builder to check, made on 2026-11-08 to fix review findings on plan Tasks 12 and 14.

**What was wrong.** A no-buyer charge read like any allowed order on its trace page, with nothing saying no buyer was at PayPal or
whether anyone approved it. A rail mismatch showed as "Allowed (mismatch)". The concurrency harness approves its own first
purchase in code, and its trace said "Human reviewed the step-up". The dispute bundle said none of this.

**Decision: read all three from the ledger as it is, with no new fields.**

- **No buyer present:** the order's first outcome is a PayPal `captured` with no capture key. Only a charge to a saved payment
  method gives that, since a checkout order is always `created` first and captured later (D-49, D-50). The page then says it was
  paid from the saved PayPal account with no buyer present, and either that no person approved it or who did. The bundle's
  `execution.paid_by` says `saved_method_no_buyer`.
- **Mismatch:** the latest outcome's status is `mismatch`. The page shows "Payment mismatch" in the refusal colour with what the
  rail reported. The bundle keeps `authorisation.decision` as Praman's `ALLOW`, which is true, and sets `execution.failed` with
  `rail_reported`. A plain `failed` now sets `execution.failed` and `execution.failure_code` too.
- **Harness approval:** the intent's `model_id` starts with `harness/`. The harness writes `harness/no-model` and no model or
  person ever does. The page calls that step-up resolution the harness's, and the bundle's `approval.by` says `test_harness`.

**Rejected: writing how an order was paid onto the outcome row.** It would be exact by construction, but it changes the executor
result shared by `exec-core`, `paypal-exec`, `razorpay-exec` and the control plane, to say something the existing rows already
show. If a rail ever captures on create for another reason, such as PayPal's auto-capture, this reading would be wrong and the
field would be worth adding.

**Rejected: an approver field on `step_up_resolved`.** Same reason: `resolveApproval` would need a new parameter, for one caller
that the intent already identifies.

### D-54 · Saved payment tokens on shutdown · Accepted

An implementer's decision for the builder to check, made on 2026-11-08 after a review finding on plan Task 14.

D-50 keeps each visitor's PayPal payment token in server memory only. A session that ends or expires deletes its token at PayPal.
A restart did not: the tokens were gone from memory and PayPal kept them, still usable with this app's credentials.

**Decision: on SIGTERM or SIGINT the server stops taking requests, ends every session, and asks PayPal to delete every saved
token at once, waiting at most five seconds, then exits.** `releaseAllSessions` in `demo/routes.ts` does it and logs how many were
deleted and how many weren't confirmed. It never logs a token.

**What this doesn't fix.** A crash, an out-of-memory kill or a SIGKILL skips it, and so does a deletion PayPal doesn't answer within
five seconds. Those tokens stay at PayPal. In the sandbox they charge play money, and they can be removed from the sandbox
dashboard. A token in a database would survive a crash and could be deleted after one; D-50 rejected that, and this doesn't
revisit it.

### D-55 · The hosted demo runs on Render Free with Neon Free Postgres · Accepted

The builder's decision, made for plan Task 13 on 2026-11-08. The design said Render with its own managed Postgres. This record
says what was chosen instead and what follows from it. `docs/DEPLOY.md` has the steps.

**Decision: one Render Free web service in Virginia, a Neon Free Postgres in AWS us-east-1, and an outside ping to `/healthz`
every 10 minutes from cron-job.org.** Razorpay keys are optional on the host; the demo's shops use PayPal and the simulated rail.

The facts it is built around:

- A free Render service sleeps after 15 minutes with no requests, can restart at any time, and loses its disk on a restart.
- Neon Free gives 100 compute hours a month, and suspends the database after 5 minutes idle. The next query wakes it.
- Render's free Postgres is not used: it expires a month after it is made, and the demo has to outlive judging.

What follows:

- **`/healthz` answers from memory.** The ping keeps Render awake and never wakes Neon. A test checks it runs with no database.
- **Nothing is kept on disk.** Visitors' sessions are in memory, so a restart ends them (D-51). The ledger, the daily usage
  counts (D-57) and every trace are in Neon.
- **Two Neon addresses.** The server uses the pooled one, `DATABASE_URL`. Migrations use the direct one,
  `DIRECT_DATABASE_URL`, because `prisma migrate deploy` takes a lock a pooled connection can't hold. They run in the Render
  build, since Render's pre-deploy command isn't on the free plan. Local dev leaves `DIRECT_DATABASE_URL` empty and nothing
  changes there (`f37a577`).
- **Anything that queries on a timer has to stop when nobody is here,** or Neon never suspends. D-56 is how the sweeps do that.

**Rejected: a paid Render instance.** It doesn't sleep, but it costs money for a demo that is idle most of the day, and the ping
does the same job for free.

**Rejected: Render's free Postgres.** Its expiry would delete the ledger, and with it every trace a judge might open.

### D-56 · The sweeps run inside the server, only while the demo is in use · Accepted

An implementer's decision for the builder to check, made in plan Task 13 on 2026-11-08 (`8b6cc65`).

The demo page promises two things: a PayPal checkout nobody pays is released after 10 minutes, and a payment call left with no
answer gets settled. Locally, `pnpm reconcile` does both. On the host, nothing ran it, so neither promise held.

**Decision: the server runs `reconcilePending` then `releaseStaleOrders` once when it starts, and then every minute, but only
while someone has used `/demo` in the last 30 minutes.** `apps/receipt-ui/src/sweeps.ts` does it.

- **Each sweep has its own `try`.** A failed reconcile still lets release run, and a failed pass is logged by error name and
  tried again next minute. A pass still running when the next minute comes is skipped, not run twice at once.
- **The rails it asks are the ones this server has keys for:** PayPal, and Razorpay only if its test keys are set. Not the
  simulator: asked about a real PayPal order, it would answer "not found".
- **A checkout is released between 10 and 11 minutes** after it was made: the 10-minute rule in `releaseStaleOrders`, checked
  every minute.
- **Tests go through the running server's path,** not just the sweep functions: the app built as `server.ts` builds it, a
  checkout left unpaid, the clock moved past 10 minutes, then capture refused with `ORDER_RELEASED` in plain words; and a charge
  whose answer was lost, settled once by the sweep and not charged again.

**What this leaves.** A payment left pending when nobody visits for 30 minutes stays pending until the next visit or the next
restart. Its budget stays held in the meantime (D-42), which is the safe direction: nothing can be spent twice while it waits. A
capture PayPal completes is also settled by the webhook (D-45), which doesn't wait for the sweep.

**Why 30 minutes.** It covers the 10-minute release with room to spare. Neon then stays awake about 35 minutes after the last
visit, and suspends after that.

**Rejected: running every minute, always.** It would keep Neon awake all month: 720 hours at the smallest size, 0.25 CU, is 180
compute hours, nearly twice the free 100.

**Rejected: a Render cron job.** Render's cron jobs are not free, and would be a second service to deploy and keep in step.

### D-57 · How the public demo is limited · Accepted

An implementer's decision for the builder to check, made in plan Task 13 on 2026-11-08 (`29e221c`). The builder set the goal:
anyone can use the demo, and nobody can run up the model bill or fill the database.

**Decision: per-address and per-session limits in memory, and two daily caps for everyone together in Postgres.**

| Limit | Per | Kept in | Over it |
|---|---|---|---|
| 5 new sessions in 10 minutes | address | memory | plain 429 |
| 60 trace, verify, dispute and index requests a minute | address | memory | plain 429 |
| 120 webhook deliveries a minute | address | memory | 429, PayPal retries |
| 30 button presses a minute | session | memory | plain 429, nothing run twice |
| 40 model calls | session | memory | the step stops, nothing moves (D-51) |
| 200 new sessions a day (`DEMO_DAILY_SESSIONS`) | everyone | `demo_usage` | plain page until 00:00 UTC |
| 400 model calls a day (`DEMO_DAILY_MODEL_CALLS`) | everyone | `demo_usage` | recorded model answer, labelled |

- **The daily caps are in Postgres** so a restart doesn't refill them. One statement adds one only while the count is under the
  cap, so two requests at once can't both take the last one. `demo_usage` is a plain counter, not the ledger, and is updated in
  place; invariant 4 is about the ledger and is untouched.
- **Past the model cap, the story goes on with a recording.** Each step replays what `google/gemini-3.1-flash-lite` answered to
  the same goal in a run on 2026-11-07, read back from that run's ledger traces. The page says "Recorded model answer, not live",
  and the intent's model id starts with `recorded/`, so the trace and the dispute bundle say it too. The tools still run live,
  Praman still prices the cart from the catalog and decides it, and the sandbox money is real. A judge who arrives late still
  sees every step work.
- **Per-address limits read the first `X-Forwarded-For` entry** behind Render's proxy (`TRUST_PROXY=1`). If Render passes on
  what a client puts there, a script can claim a new address each time, so these limits slow casual use, not a determined
  script. The daily caps and per-session limits are the bounds nothing in a request can get around. `docs/DEPLOY.md` has a
  check for which it is.
- **The per-address limits are in memory,** so a restart resets a window of a few minutes, which costs nothing.

**Rejected: per-address limits in Postgres.** Every page view would write to the database, and keep Neon awake.

**Rejected: a CAPTCHA.** It means a third party's script on every page, against the CSP (D-59), and one more thing between a
judge and the demo.

**Rejected: stopping the demo at the model cap.** A judge arriving that evening would see nothing work. A labelled recording
shows the same thing Praman does, with the model's part marked as replayed.

Status: the `X-Forwarded-For` bullet is replaced by D-60, which reads the address the proxy added, not the client's.

Status: the "plain page until 00:00 UTC" row is replaced by D-61. Past the session cap, visitors get a labelled recorded run.

### D-58 · The server refuses to start rather than run with the wrong keys · Accepted

An implementer's decision for the builder to check, made in plan Task 13 on 2026-11-08 (`ed17165`).

**Decision: `apps/receipt-ui/src/startup.ts` checks the environment before the server listens, prints each reason naming the
variable but never its value, and exits.** It refuses when:

- `PAYPAL_BASE_URL` is set to anything but `https://api-m.sandbox.paypal.com`. The PayPal client is built with the sandbox
  constant anyway; this catches a deploy that thinks otherwise.
- PayPal's sandbox token endpoint answers 401 or 403 to `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`. Live and sandbox
  credentials are separate sets, so ones the sandbox refuses aren't sandbox ones. If the sandbox can't be reached, the server
  starts anyway with a note, since every call it makes goes to the sandbox host.
- `RAZORPAY_KEY_ID` doesn't start with `rzp_test_`, or `RAZORPAY_BASE_URL` is set at all (the executor only calls
  `api.razorpay.com`).
- Only one of a pair is set: PayPal id and secret, Razorpay id and secret, or the demo's private and public key.
- The demo key isn't a key, its halves don't match, or it is the local `MANDATE_PRIVATE_KEY`.

In production (`NODE_ENV=production`) it also refuses when:

- the demo key is one of the developer keys whose public fingerprints are listed in `startup.ts`: the local mandate key and
  the demo key used for local runs. A fingerprint of a public key is not a secret.
- `MANDATE_PRIVATE_KEY` is set at all,
- the demo key is missing, or `DEMO_BASE_URL` isn't `https://`.

The hosted key pair is fresh from `pnpm keygen`, kept in the gitignored `private/demo-mandate-keys.env`, and passes every check
above. A test starts the real server process with a bad setting and sees it exit before it listens.

**Rejected: a warning in the log.** Nobody reads the log of a free host until something has gone wrong, and the thing that went
wrong would be a live key or a stranger's mandate signed with the developer's key.

**Rejected: checking Razorpay keys with a call.** The `rzp_test_` prefix already tells test from live, and the demo doesn't use
Razorpay.

### D-59 · A strict content security policy, and errors that say nothing · Accepted

An implementer's decision for the builder to check, made in plan Task 13 on 2026-11-08 (`6549ca7`, `e2fa25d`).

Every page escapes what it shows: merchant text, model rationale, ids and codes. The policy is the second line, for anything
that ever slips past.

**Decision: every response carries this policy and these headers.**

```
default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com;
font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self';
form-action 'self' https://www.sandbox.paypal.com; frame-ancestors 'none'; base-uri 'none'
```

plus `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`,
`Cross-Origin-Opener-Policy: same-origin`, a `Permissions-Policy` that turns off camera, microphone, location and payment, and
`Strict-Transport-Security` when the server's address is `https://`.

- **No inline script or style anywhere.** The page scripts and styles moved into files served from this origin, so the policy
  needs no `'unsafe-inline'` and no nonces. The trace page reads its trace id from a data attribute and builds its chain-break
  note as text, not HTML.
- **`form-action` names PayPal's sandbox** because Connect PayPal posts here and is redirected on to PayPal, and a browser
  checks the redirect against `form-action` too.
- **Error pages say nothing about the error.** The catch-all 500, in the main server and in the demo, shows a fixed sentence.
  The operator log gets the error's name and message. An error's text can carry a query, a URL or a provider's reply, so the
  visitor never sees it. The index page is rendered before its status goes out, so a database failure there is a 500 page, not
  an empty 200.
- **`/healthz` answers before anything else** and touches nothing (D-55).

**Rejected: nonces on inline blocks.** Every page would need a per-request nonce passed through its renderer, for a handful of
scripts that work as well as files.

**Rejected: loading the fonts from this origin.** It would let `style-src` and `font-src` be `'self'` alone, at the cost of
committing font files. Google's two hosts serve only CSS and fonts, which can't run script under this policy.

### D-60 · Per-address limits read the address the proxy added · Accepted

An implementer's decision, made on 2026-11-08 after a review of the Task 13 work found the per-address limits could be skipped
with one header. It replaces D-57's `X-Forwarded-For` bullet.

D-57 read the first, leftmost `X-Forwarded-For` entry. A client writes that entry itself, and a proxy that appends keeps it, so
a script sending `X-Forwarded-For: 10.0.0.<i>` got a fresh limit on every request. A reviewer showed fifty new sessions from
one client. Enough of those would use up the day's 200 sessions for everyone.

**Decision: `TRUST_PROXY` is the number of proxies in front of the server that append the address they saw, and the limits
read the entry that many places from the right.** Each proxy appends on the right, so that entry was written by the outermost
proxy this server trusts, and no client can choose it. Render is `1`. With fewer entries than that, the leftmost is used. `0`
or unset reads the socket's address, as local runs do. Anything but one digit stops the server at start (D-58).

Nobody here has seen the header Render actually sends. If Render's own proxy appends a second, internal address, the rightmost
entry would be the same for every visitor, and the limit would shut out everyone together. `docs/DEPLOY.md`'s smoke test
checks both ways it could go wrong: eight requests with made-up addresses must hit the limit, and a phone on another network
must still get in. If the phone is refused, `TRUST_PROXY=2` is the fix.

**Rejected: `CF-Connecting-IP` or `True-Client-IP`.** Cloudflare sets them where it is in front, but nothing in Render's
documentation that this repo relies on promises them, and where Cloudflare isn't in front a client can send them itself.

**Rejected: a list of Render's proxy address ranges.** Not published in a form this repo could check, and it would go stale.

### D-61 · Past the daily session cap, visitors get a recorded run · Accepted

An implementer's decision, made on 2026-11-08 after a review of the Task 13 work. It replaces D-57's row for the session cap.

D-57 rejected stopping the demo at the model cap, because a judge arriving that evening would see nothing work. The session cap
did exactly that: once the day's 200 sessions were gone, **Start a session** answered with a 429 and the start page, and nothing
of the story was visible until 00:00 UTC. Task 13 asked for a labelled recording once a cap is reached.

**Decision: past the session cap, `POST /demo/start` redirects to `/demo/recorded`.** That page says first, in bold, "Recorded
run, not live", says the live demo opens again at 00:00 UTC, and shows a screenshot of one complete session: all seven steps,
from `docs/screenshots/demo-story-desktop.png`, with alt text that walks through each. It has no buttons, starts no session,
sets no cookie, and touches no database. It can be opened any time, so the builder can see what a late visitor gets.

- **A screenshot, not a replay.** A replayed session would still need a session, PayPal calls and database writes, which is
  what the cap bounds. The screenshot costs nothing to serve.
- **It follows the screenshots.** The page serves the file the screenshot script writes, so when the final polish task
  regenerates the screenshots the recorded run updates with them.
- **The cap still holds.** Nothing past it creates a session, and the per-address limit (D-60) still slows one source using
  the day's sessions up.

**Rejected: raising or removing the session cap.** Sessions hold memory, PayPal vault tokens and ledger rows. The cap is what
keeps one script from filling them; the recorded run is what keeps the cap from hiding the product.

**Rejected: a per-address share of the daily cap.** It would need per-address counts that survive a restart, and it is only
as strong as the address it keys on.

### D-62 · The ledger console uses AG Grid and AG Charts Community, served from this app · Accepted

The builder decided on 2026-11-08 to build an operator console with AG Grid Community and AG Charts Community, both MIT
licensed and free, and not AG Grid Enterprise or AG Studio. It aims at the design criterion and the "Best Use of AG Grid"
prize, so it has to be a tool an operator would use, not a picture. The details below are the implementer's.

**Decision: `ag-grid-community@36.2.0` and `ag-charts-community@14.2.0`, exact versions in `apps/receipt-ui/package.json`,
served at `/assets/vendor/<package>-<version>.min.js` from `apps/receipt-ui/node_modules`.** `assets.ts` reads each package's
own `package.json` at start and refuses to start if the installed version isn't the pinned one. The newest releases (36.3.0
and 14.3.0) were four days old, so the previous minor of each was taken.

- **The grid's noStyle build.** The full build adds the old CSS themes to the page as `<style>` elements the moment it loads,
  with no nonce, and the page's policy blocks them. The noStyle build leaves them out. The theme the console uses, Quartz with
  the site's paper, inks and fonts, is built at runtime and carries the nonce (D-63).
- **The page carries no ledger data.** The script fetches JSON from the data route and puts every value in as text. The one
  cell renderer, the trace link, returns an `<a>` element built with `textContent`, because AG Grid inserts a string a
  renderer returns as HTML. Chart tooltips use the object form, never an HTML string.
- **The server does the money and the hashing.** Amounts arrive formatted by `formatMoney`; the browser sorts minor units with
  `BigInt` and uses them as numbers only to place chart points. Hash checks are recomputed on the server with the ledger's
  `computePayloadHash` and `computeEntryHash`, and the chain is walked with `verifyChain()`.

**Rejected: a CDN.** It would put a third party in `script-src`, and a CDN copy can change under a pinned URL only if the CDN
misbehaves, but the policy would have to trust it anyway.

**Rejected: hand-built tables and SVG charts.** Possible, but the builder asked for AG Grid, and its column filters, quick
filter, sorting and virtualised rows are what an operator reading two thousand rows needs.

### D-63 · The console page adds a per-response style nonce to the policy · Accepted

An implementer's decision, made on 2026-11-08 while building D-62.

AG Grid's theme and AG Charts both put their CSS into `<style>` elements in the browser. D-59's policy allows style only from
this origin and Google's font stylesheet, so those elements were refused and the grid and charts drew unstyled.

**Decision: the console page, and only that page, sends `style-src 'self' 'nonce-<n>' https://fonts.googleapis.com`, where
`<n>` is 18 random bytes made fresh for every response.** The nonce goes to the browser as the `nonce` attribute of the
console's own `<script>` tag, the script reads it from `document.currentScript.nonce` (which browsers hide from markup and
selectors), and passes it to both libraries as `styleNonce`. Everything else in the policy is D-59's, unchanged:
`script-src 'self'`, no `'unsafe-inline'`, no `'unsafe-eval'`. Tests check the console's policy is exactly D-59's plus the
nonce, and that two responses get different nonces.

Checked in headless Chrome against the running server: with the noStyle grid build, no policy violation is reported, every
`<style>` element on the page carries the nonce, and a ledger row whose merchant id was `<img src=x onerror=...>` showed as
that text, with no element created and no script run.

**Rejected: `'unsafe-inline'` for style.** It would let any injected `<style>` apply, on the one page that shows ledger
values.

**Rejected: hashes of the injected CSS.** The CSS depends on the theme parameters and the library version, so the list would
break on every change.

**Rejected: extracting the libraries' CSS into served files.** AG Charts also adds small style elements as charts draw, and
copying CSS out of a bundle by hand would break on the next version.

A CSP nonce is not a credential: it lets a style element apply on one response and does nothing else.

### D-64 · Who sees which ledger rows in the console · Accepted

The builder decided on 2026-11-08 that on the hosted demo a visitor's console shows only their own session's mandates, and
that locally, with the demo off, an operator mode shows everything. How that is enforced is the implementer's.

**Decision: two routes with different scopes, chosen by the server, never by the request.**

- **`/demo/console/data`** reads the visitor's session from its cookie, the same way every demo route does (D-51), and loads
  every trace in which some row's `payload->>'mandate_id'` is one of that session's two mandate ids. That takes in the
  purchases, the twenty-at-once test and the revocation, and nothing of anyone else's. No query value names a mandate or a
  trace. With no session it answers 401. Each load walks the whole chain, so it is limited per session like a button press.
- **`/console` and `/console/data`** exist only when `server.ts` passes `operatorConsole: true`, which it does only when the
  demo is off (no demo key) and `NODE_ENV` isn't `production`. Otherwise both answer 404 with a sentence saying why. It shows
  the newest 2000 rows and says when there are more.
- **Budget lines.** A visitor's console draws each mandate's signed budget from the session's own signed documents. The
  operator console holds no signed mandates, so it draws spend without a budget line and says so.

**Rejected: an operator password or token.** It would be a secret to send to a browser and keep safe on a free host. With the
demo on, the whole-ledger view simply doesn't exist.

**Rejected: filtering by merchant.** Every visitor buys at the same demo merchants, so a merchant filter would show one
visitor another's purchases.

### D-65 · The demo's revoke step · Accepted

The builder asked on 2026-11-08 for a demo step "Revoke the mandate": the visitor revokes, the agent tries again, and Praman
answers DENY `MANDATE_REVOKED` with no charge, using the existing `mandate_revoked` ledger event. The details are the
implementer's.

**Decision: step 8 calls `revokeMandate()` in `packages/control-plane`, the same function `pnpm revoke` now calls.** It appends
one `mandate_revoked` row under the per-mandate lock that `runIntent` and `resolveApproval` take, so a revocation racing a
purchase commits first or not at all. Then **Ask the agent to buy a coffee** asks the live model with step 4's goal, so the
only thing that changed is the revocation, and the intent goes through `runIntent` like any other.

- **The reason is fixed text and the trace id is `trc_demo_<session ref>_revoke`.** Nothing a visitor sends reaches the
  ledger, and the trace page leads back to the demo.
- **It runs once.** Pressing it again shows the result; the ledger gets one row. The retry is not offered again after Praman
  refuses it, because a second ask would spend a model call to be refused the same way.
- **It is offered last and says so.** After it every purchase in the session is refused, and a checkout still waiting at
  PayPal is refused at capture with `MANDATE_REVOKED` (D-31). A test covers that case.
- **No policy change.** `evaluate()` already checks revocation second, after idempotency. `packages/policy` is untouched.

**Rejected: a revoke route that takes a mandate id.** The session's own mandate is the only one a visitor may revoke, so the
route names none.

### D-66 · Only a person refunds, through the same outbox as any money action · Accepted

The builder set the requirements on 2026-11-08: refunds through PayPal's Payments API, started only by a person, through the
same two-phase outbox as every money action, with a derived `PayPal-Request-Id`, the outcome appended and nothing rewritten, and a
full refund only unless partial is trivial and safe. The details below are an implementer's decisions for the builder to check.

**Decision: `refundOrder` in `packages/control-plane` refunds the one captured payment on a trace, in full.** It follows
`captureOrder`'s shape (D-22, D-40):

1. **Before T1.** Find the one captured order on the trace, from the intent rows, the order records and the ledger's outcome rows.
   Check that this process has a rail that can refund it.
2. **T1, under the mandate lock.** Look again. If the ledger already has a refund that isn't a failure, answer with it and call
   nothing. If a refund record is still pending, answer that it is open. Otherwise commit a pending `refund` record and one
   `refund_requested` row, whose actor is the person who asked.
3. **The call, outside any transaction.** `POST /v2/payments/captures/{capture_id}/refund`, with the captured amount stated and the
   refund key as `PayPal-Request-Id`.
4. **T2, under the lock.** If the record is still pending, append one `refund_outcome` and settle the record.

| What PayPal answers | `refund_outcome.status` | Refund record |
|---|---|---|
| 201 or 200, `COMPLETED`, the money asked for | `refunded` | succeeded |
| `PENDING` | `pending` | stays pending, so the reconciler follows it up |
| `CANCELLED`, `FAILED`, or a named 4xx such as `CAPTURE_FULLY_REFUNDED` | `failed` | failed; a later request may try again |
| a refund of other money or currency | `mismatch`, with what the rail said in `rail_` fields | succeeded, never sent again |
| no answer, a 5xx or 409, an unreadable body, a link naming another capture | nothing | stays pending |

Each part answers a question:

- **Who can start one?** Only `pnpm refund <trace_id>`, recorded as `operator`, and `POST /demo/refund/<step>`, recorded as
  `demo_visitor`. The demo route names a step of the visitor's own session, never a trace, and the lookup is scoped to that
  session's mandate, the same way every other demo route works (D-51). The buyer agent's tools are reading the catalog and proposing
  a cart, and a test pins that list. `pnpm lint:boundary` now fails if the agent, its model providers or the merchant tool server
  name `refundOrder`, `reconcileRefund` or a refund call.
- **Where does the key come from?** `refundRecordKey(orderKey, captureId, attempt)`: `sha256("refund|" + orderKey + "|" + captureId)`
  for the first attempt, with `"|" + n` after a definite refusal, as capture keys do (D-40). Derived, never random, never supplied.
- **Why is the mandate not re-checked?** A refund is not the agent spending. It can't be started by an agent, it sends money back to
  the person the mandate protects, and a revoked or expired mandate is no reason to keep their money. A test refunds after
  revocation. `packages/policy` is untouched and `pnpm lint:policy-freeze` passes.
- **Why no reason code for a refusal?** Nothing here is a policy decision. "Nothing on this trace was paid" is a fact about the
  ledger. `refundOrder` returns `CANNOT_REFUND` with a closed list of five reasons and a fixed sentence, writes no row, and calls
  nothing. Reason codes stay what Praman decides about an agent's purchase (invariant 8).
- **Why new event types and not `outcome`?** Every reader of `outcome` treats its last row as where the order stands: the trace
  page's headline, the dispute bundle's `execution`, the release sweep, settlement matching. A refund row there would make each of
  them reason about refunds. `refund_requested` and `refund_outcome` are read only by the code that means to, and both carry the
  order's `idempotency_key` and `order_id`, like every capture row (D-30, D-34), with the refund's own key as `refund_key`.
- **Why full only?** A partial refund needs an amount, which needs an input on a page whose rule is that no request carries a
  value (D-51), and a second refund on one capture needs its own key scheme and a running total to check against. Neither is
  trivial, so neither is built. The amount sent is always the one the ledger recorded as captured.
- **Why is a mismatch order refused?** Its rail once answered about other money (D-33). Which amount to give back is a question for
  a person with PayPal's dashboard open.

**The reconciler.** `reconcilePending` now settles `refund` records too, by sending the same request again under the record's own
key. D-68 shows PayPal answers that with the refund it already made. A refund PayPal still calls `PENDING` writes nothing new and
stays open. The demo's in-server sweep (D-56) runs the same function, so it settles refunds on the host.

**What every reader shows.** The trace page has a Refund section that says what happened, who asked, and that the budget still
counts the purchase. The demo's own view of a purchase step, `/demo/r/<step>`, is that page plus a refund button while no refund is
done or under way; the public page at `/r/<id>` never has a button. The dispute bundle gains `refund`, with `budget_returned: false`
always. The console shows the rows with a refund id column, and its rails chart counts a captured order whose money went back as
refunded.

**Rejected: a refund tool for the agent, or the PayPal Agent Toolkit's.** That is the money-moving tool Praman exists to stand in
front of, pointed the other way. Moving money back still moves money.

**Rejected: refunding through the order instead of the capture.** PayPal's Orders API has no refund. The capture id is on the
ledger already, on the `captured` row.

**Limits.** Razorpay has no refund here: it stops at order creation in this repo, so its executor has no `refund` and a refund of a
Razorpay trace is `rail_cannot_refund`. PayPal's `PAYMENT.CAPTURE.REFUNDED` webhook is still ignored, so a refund made in PayPal's
dashboard doesn't reach the ledger; Praman's own refund of that capture then gets `CAPTURE_FULLY_REFUNDED`, recorded as failed,
which is true of that call. A refund PayPal keeps at `PENDING` for good stays open for good, and holds nothing, since refunds
never touch budget (D-67).

### D-67 · A refund gives no budget back · Accepted

The builder asked on 2026-11-08 for this to be decided, recorded and tested, with two fixed points: a refund that is pending or
unknown never frees budget, and no buy, refund, buy loop can take an agent past its mandate. The choice is an implementer's for the
builder to check.

**Decision: a refund changes nothing in `deriveState`, whatever its status.** Spend, velocity, merchant trust and seen keys are the
same before and after. `deriveState` names both refund event types and skips them, so this reads as a decision in the code, not
as the default branch.

In plain words: the mandate's budget is the most that may go out under this one signature. Money coming back to the buyer doesn't
raise that ceiling. A person who wants the agent to spend more signs a new mandate, which is one click in the demo and one
`pnpm issue-mandate` locally.

**Why this and not net spend.** Counting refunds against spend would mean:

- A person refunding a wrong purchase silently hands the agent that much new room to spend. That isn't what they asked for.
- The loop the builder named becomes possible: an agent buys, a person refunds, the agent buys again, and the total that went out
  under one mandate is no longer bounded by it. Only a person can refund (D-66), so the loop needs one, but the mandate's job is to
  be the bound without relying on that.
- Only a completed refund could ever count, so the rule would need a careful distinction between `refunded`, `pending`, `mismatch`
  and an open request. Not counting refunds at all needs none, and the two fixed points hold by construction.

**Velocity counts the purchase too.** It happened, and the rate limit is about how often the agent buys.

**What a person sees.** The trace page, the demo page and `pnpm refund` all say that the budget still counts a refunded purchase.
The console's spend line doesn't move at a refund, and the bundle says `budget_returned: false`.

**Tests.** `deriveState` gives the same state before and after a `refunded`, `pending`, `failed` or `mismatch` refund, and after a
request with no answer. A control-plane test buys under a mandate with room for one more purchase, refunds it, and the next
purchase is refused `MANDATE_BUDGET_EXHAUSTED`. A pending refund leaves state unchanged before and after the reconciler records it
as done.

**Rejected: freeing budget on a completed refund.** It is the net-spend rule above, with its loop.

**Rejected: a separate refund allowance on the mandate.** A new limit is a new mandate field and a policy change, and
`packages/policy` is frozen (D-31, D-43).

**Consequence.** On a long-lived mandate with many refunds, the budget runs out faster than the money that actually left. That is
the cautious direction. If the builder wants net spend later, it is one change in `deriveState`, and D-43's point applies: it would
change what `evaluate()` is told without changing `evaluate()`.

### D-68 · What a live PayPal refund does in the sandbox · Accepted

An implementer's record for the builder to check, from 2026-11-08, in the style of D-26 and D-49. Two kinds of run: a throwaway
script outside the repo calling PayPal directly on a capture named in D-49, and `pnpm refund` through Praman's own code on two
captured demo purchases in the local ledger.

**On D-49's $2.00 capture `68C05697TX7382946`, order `0G353546C23905239`.**

| Request | Observed |
|---|---|
| GET the capture first | 200, `COMPLETED`, $2.00 |
| Refund $2.00 with key A | **201**, refund `7DA46548R94559222`, `COMPLETED`, $2.00. Body keys: `id`, `status`, `amount`, `seller_payable_breakdown`, `create_time`, `update_time`, `links` (`self`, and `up` naming the capture) |
| The same again, key A | **200, the same refund.** No second refund |
| Key A with $1.00 | **200 and the $2.00 refund, with no error.** D-26's silent reuse again |
| A new key B, $2.00 | 422 `CAPTURE_FULLY_REFUNDED` |
| No key, empty body | 422 `CAPTURE_FULLY_REFUNDED` |
| GET the capture after | 200, `REFUNDED` |
| GET the refund | 200, `COMPLETED`, $2.00, now with `payer` |
| GET the order | `COMPLETED`, one capture `REFUNDED`, and a `refunds` list with the one refund |

**Through Praman, on the local ledger.** `pnpm refund trc_demo_7e7de65ab5a2_second_5`, a $4.50 coffee paid with no buyer present
in P14, refunded as `2JV473619H1766245`. Run again, it answered from the ledger with the same refund and called nothing. `pnpm
refund trc_demo_fe70eb7e4119_large_8`, a $32.00 team lunch the buyer paid at PayPal's checkout and Praman captured, refunded as
`90W33293UC2395338`. Each trace gained one `refund_requested` row by `operator` and one `refund_outcome` row, `refunded`. The two
mandates' `spent_minor` still count both purchases (1700 and 4900 minor units). `pnpm verify-ledger` passed over 1249 entries.

**What each result means for the code.**

1. **The reconciler's resend is safe.** The same key returns the same refund with 200, so a refund whose answer was lost is sent
   again under its key and gives one refund. D-66's reconciler relies on this.
2. **`acceptRefund` is needed.** A reused key asking for other money gets the old refund with no error. Praman's keys come from the
   order key and capture id, and the amount is always the captured one, so this should be unreachable; it is checked because it
   fails silently if it is ever reached.
3. **PayPal itself refuses a second full refund**, with or without a key. So even a bug that sent a second request couldn't return
   the money twice, and Praman's own check stops it before a call.
4. **A refunded capture still reads as captured through `findOrder`.** D-38 maps a capture's `REFUNDED` to `captured`, since the
   payment happened. That is right for the release sweep, which must never release an order whose money moved, and nothing else
   reads it for refunds.
5. **The response names its capture only in the `up` link,** so `paypal-exec` checks that link when it is there and treats an answer
   about another capture as unknown.

**Not seen.** A refund at `PENDING`, `CANCELLED` or `FAILED`: every refund here completed in its first answer, so those rows of
D-66's table rest on PayPal's documented statuses. A refund webhook. How long PayPal keeps a refund key.

**Limits.** One app on one sandbox account, on one day, and each row was run once. The test fixture `liveRefund` in
`packages/paypal-exec/test/documented-shapes.ts` is this run's answer, trimmed to the fields `paypal-exec` reads.

---

### D-69 · The MCP gateway holds the mandate, and an agent names only a SKU and a quantity · Accepted

An implementer's decision for the builder to check, made on 2026-11-08 on the MCP lane (branch `paypal-hackathon-mcp`, merged in P19).

The design's first stretch item was a local MCP server that is the only spending route for Claude Desktop, Claude Code or
any other MCP client. The question is what such a client may say.

**Decision: `propose_purchase` takes `merchant_id`, `sku` and `qty`, and nothing else. The server loads one signed mandate
from a local file at start and every proposal runs under it, through `runIntent`.** Every input schema is a strict object,
so a call that adds `price_minor` or `mandate_id` is refused by the MCP layer before anything reaches the ledger.

- The price is the catalog's, the currency the mandate's, and the rail the merchant row's (D-29, D-32). The MCP layer adds
  nothing to `PurchaseIntent` that a model wrote except the SKU and quantity, which `evaluate()` already treats as
  untrusted. `agent_rationale` is a fixed string, not model text.
- The model id on the `intent` event is the MCP client's self-reported name and version, as `mcp:<name>@<version>`,
  sanitised and cut to 80 characters. Provenance only; nothing reads it to decide.
- A mandate that doesn't verify, no mandate file, or no PayPal keys outside `PRAMAN_MCP_SIMULATE=1` stops the server before
  it takes a call. There is no default rail.
- `get_receipt`, `check_approval` and `complete_checkout` answer only about traces whose `intent` row carries this
  gateway's mandate id. Anything else is `NOT_FOUND`, so one gateway can't read another mandate's purchases.
- `DENIED` carries the reason code and a plain line from `apps/mcp-gateway/src/plain.ts`, a `Record<DenyCode, string>`, so a
  new reason code doesn't compile until it has words. No line states a limit (D-08); a test checks the reply to a refused
  over-limit purchase for the limit values.
- Rail and status in every answer are read back from the outbox record and the ledger (`view.ts`), the same sources the
  trace page reads, not from what the call returned.

**Rejected: a mandate path or id as a tool argument.** It would let a client pick which authority to spend under. One
server, one mandate, set by whoever starts the server.

**Rejected: wrapping only the text content.** `structuredContent` carries the wrapped string too (`merchant_content`) and no
bare `title` or `description` field, so a client that reads the structured half gets the same delimiters (invariant 7).

---

### D-70 · A sixth tool, `complete_checkout`, captures after the buyer pays · Accepted

An implementer's decision for the builder to check, made on 2026-11-08 on the MCP lane (branch `paypal-hackathon-mcp`, merged in P19).

The brief listed five tools. On the PayPal sandbox every order the gateway creates is a checkout order, since there is no
saved payment method outside a demo session (D-50). The buyer pays at PayPal's page, and then someone has to capture. With
only the five tools, nothing could finish a purchase.

**Decision: `complete_checkout(trace_id)` calls `captureOrder`.** It takes only the trace id. The amount is the one T1
authorised, and `captureOrder` re-checks the mandate (D-31) and asks PayPal what the order now says before capturing. It
does nothing unless the trace is `EXECUTED` and `awaiting_buyer`. Before the buyer approves, PayPal answers
`ORDER_NOT_APPROVED` (seen live on 2026-11-08, see the recorded session in `docs/MCP.md`) and the agent is told to wait.

The agent calling capture is safe for the same reason the demo's capture button is: no money moves until a person has
logged in at PayPal and approved that exact order, and Praman checks the mandate again at that moment.

**Rejected: capturing inside `get_receipt` or `check_approval`.** A read that can move money surprises everyone who reads
the tool list.

---

### D-71 · An identical proposal within two minutes is a retry · Accepted

An implementer's decision for the builder to check, made on 2026-11-08 on the MCP lane (branch `paypal-hackathon-mcp`, merged in P19).

An MCP client that times out may send the same `tools/call` again. Each proposal gets a fresh `intent_id`, so the
idempotency key (invariant 6) would differ and Praman would see a second purchase.

**Decision: the gateway remembers each (merchant, SKU, quantity) it proposed for two minutes, in memory. A repeat inside
that window gets the first proposal's current answer with `retry_of`, and nothing is evaluated or written.** The entry is
set before `runIntent` is awaited, so two overlapping identical calls also resolve to one.

The cost is that buying the same thing twice on purpose within two minutes isn't possible; the agent uses `qty` instead,
and the tool description says so. A restart forgets the window, and then the mandate's own limits still bound what a
duplicate can spend.

**Rejected: a deterministic `intent_id` from the arguments and a time bucket.** It reuses invariant 6 directly, but a retry
that straddles a bucket edge is a second purchase, and a step-up repeat would land on `DUPLICATE_INTENT` and count toward
the denial-rate cap.

---

### D-72 · A step-up from the gateway needs a person at a terminal · Accepted

An implementer's decision for the builder to check, made on 2026-11-08 on the MCP lane (branch `paypal-hackathon-mcp`, merged in P19).

`APPROVAL_REQUIRED` gives `pnpm mcp:approve <id> approve`. Claude Code can run shell commands, so the agent that proposed
the purchase could run that command itself.

**Decision: `pnpm mcp:approve` refuses to run unless stdin and stdout are a terminal, shows the merchant, items and total,
and asks the person to type the verdict.** Claude Code's Bash tool has no TTY, and a test runs the command with piped
stdio and checks the refusal. The answer the agent gets also says "Don't run it yourself."

**What this doesn't stop.** An agent with a shell can fake a terminal (`script(1)` does it; the recorded session used it to
type the operator's approval). The honest boundary is stated in `docs/MCP.md`: the gateway is the only route to money when
the agent has no other one, as with Claude Desktop and only this server. On PayPal there is a second person anyway: a
checkout order moves nothing until the buyer logs in at PayPal and approves it.

**Rejected: a one-time code printed to the terminal.** Anything printed there is readable by an agent that ran the
command. A real fix is approval on another device, which D-36 already leaves open for the hosted demo.

---

### D-73 · Channel3 prices are pinned at import, from the JSON's own text · Accepted

An implementer's decision for the builder to check, made on 2026-11-08 on the MCP lane (branch `paypal-hackathon-mcp`, merged in P19).

The gateway's catalog is real products from Channel3 (`POST https://api.trychannel3.com/v1/search`, `x-api-key` header,
1000 free credits a month). Channel3 sends each offer's price as a JSON number in dollars, such as `22.99` or `30.0`.

**Decision: `pnpm catalog:channel3` reads every `price` through `JSON.parse`'s reviver `context.source` (Node 21 and
later), so the importer only ever holds the price as the string Channel3 wrote, and converts that string to cents with
`decimalToMinor`.** Up to two decimals are accepted and padded; three decimals, an exponent, a sign or a leading zero is
refused, never rounded. A runtime without `context.source` fails closed.

- **Pinned, with provenance.** `catalog_item` gains `source`, `source_ref`, `source_url` and `price_fetched_at`. A check
  constraint makes source and fetch time come together. `evaluate()` reads the stored price; nothing fetches live.
- **Which offer.** The cheapest in-stock offer in USD, compared as integers. A product with no such offer is skipped with
  its reason, never converted from another currency.
- **Category.** The second level of Channel3's taxonomy (`kitchen-dining`, `general-office-supplies`, `audio`), specific
  enough for a mandate to name. The gateway's mandate covers the first two, so headphones and lamps are refused with
  `CATEGORY_OUT_OF_SCOPE`.
- **Stock.** Channel3 gives availability, not a count, so an in-stock item gets 25. Stated as a stand-in in `docs/MCP.md`.
- **Text.** Titles and descriptions are stored as sent, cut to 200 and 1200 characters, with the brand and the selling
  domain prepended to the description. They are wrapped at the consumer (D-07).
- **All or nothing.** If any of the six searches fails, nothing is written. A snapshot replaces `DEMO_SHOP`'s rows and sets
  its `merchant` row to PayPal and USD in one transaction.
- **`packages/channel3` joins the import-boundary check**, since it produces prices.

**Rejected: `Number(price) * 100`.** `0.29 * 100` is `28.999999999999996` in JavaScript. Even with rounding it would be the
one float in the money path.

**Rejected: fetching at decision time.** A price that changes between the agent seeing it and Praman deciding is a price
the agent never saw, and the decision would depend on a network call inside T1.

---

### D-74 · What the agent read through the gateway is recorded on the trace · Accepted

An implementer's decision for the builder to check, made on 2026-11-08 on the MCP lane (branch `paypal-hackathon-mcp`, merged in P19).

The buyer agent records its transcript as an `agent_transcript` event, which the trace page shows as "Merchant content the
agent read". An MCP client's conversation isn't visible to Praman, but its tool calls are.

**Decision: on each proposal the gateway appends one `agent_transcript` event, `evidence_only: true`, `source:
"mcp-gateway"`, holding the `search_products` and `get_product` calls since the last proposal (at most 20) and the proposal
itself, in the same text format the buyer agent uses.** It is written in its own transaction after `runIntent`, as
`record-transcript.ts` does, and a failure is logged to stderr without changing the purchase. Checked live: the trace page
for a gateway purchase lists the three mugs the agent read, and the dispute bundle names the client and both calls.

---

### D-75 · Control characters are refused at the schema, and internal errors reach the agent as a typed ERROR · Accepted

An implementer's decision for the builder to check, made on 2026-11-08 on the MCP lane (branch `paypal-hackathon-mcp`, merged in P19).

A review found that a NUL byte in `sku`, `merchant_id`, `trace_id` or `approval_id` made Postgres reject the query
(`22021`, `22P05`). Nothing caught it, so the MCP SDK sent the raw Prisma error to the agent: absolute source paths, a
frame of source lines and the database code. Reproduced with an in-process client before the fix.

**Decision: every identifier field refuses control characters in its input schema, and the search query refuses them
except tab and line breaks. Every tool body runs inside one wrapper that turns a thrown error into `status: "ERROR"` with
one plain line, and writes the error itself to stderr.** The schema rejection is the same kind of answer as a proposal that
carries `price_minor`: the call never reaches `runIntent`, so there is no intent, no decision and no ledger row. It is not
a `DENY`, because `evaluate()` never saw it, and adding a reason code would mean touching the closed enum and the frozen
policy for an input no merchant id or SKU can contain. The denial-rate cap counts decisions, and this is not one.

The `ERROR` text for `propose_purchase` does not say nothing was bought. `runIntent` can throw in T2, after the rail took
the order, and then the pending outbox record is what `pnpm reconcile` settles. So the agent is told there is no decision
and not to propose again. For `complete_checkout` the agent is told the capture outcome is unknown.

---

### D-76 · Untrusted text has its angle brackets neutralised, not its delimiters removed · Accepted

An implementer's decision for the builder to check, made on 2026-11-08 on the MCP lane (branch `paypal-hackathon-mcp`, merged in P19).

**Supersedes D-11's mechanism.** D-11 kept untrusted text inside `<untrusted_merchant_content>` by removing literal
delimiters from it first. The removal was one split and join pass, so a nested tag rebuilt itself:
`</untrusted_merchant_</untrusted_merchant_content>content>` became a real closing tag once the inner one was removed.
Until the MCP lane that text was our own fixtures. It is now real Channel3 and retailer text.

**Decision.** `wrapUntrusted()` replaces every `<` and `>` in the merchant's text, and the small and full-width forms
that NFKC folds to them (U+FE64, U+FE65, U+FF1C, U+FF1E), with `‹` and `›`. No input can then contain a tag of any case,
spacing or nesting, because a replacement never joins two pieces of text and no bracket is left to start one.

**Rejected.** Removing in a loop to a fixed point: it closes the nesting hole, but a removal pattern still has to guess
every case, whitespace and invisible-character variant a model might read as a tag. HTML escaping to `&lt;`: models read
entities as the character, and the receipt page would show `&lt;` to people.

**Cost.** A product description with a real `<` or `>` ("bottles < 750 ml") reaches the model and the receipt page as
`‹`. That is readable, and nothing in the money path reads the text.

**Every path checked.** The buyer agent's `list_catalog` and `get_sku` and the gateway's `search_products` and
`get_product` (text and structured content) all wrap through `wrapUntrusted`. `get_receipt` returns ledger events
without payloads. PayPal webhooks never reach a prompt; `paypal-exec` keeps only allowlisted fields and its tests already
refuse a delimiter in `custom_id`. `apps/merchant-mcp` returns raw catalog text by design, and the consumer wraps it.
The gateway prints SKU and category outside the wrapper; for Channel3 rows both are restricted to plain slugs
(`skuFor`, `categoryFor`). The receipt page and dispute bundle parse the block with a lazy match up to the closing tag,
which now can only be the real one.

### D-77 · The site's front page is a fixed page at /, and the trace index moves to /traces · Accepted

An implementer's decision, made on 2026-11-08 in the final polish task. The builder had asked for a front page at `/`
that makes the case in seconds and leads into the demo; where the trace index goes was left to the implementer.

**Context.** `/` was the index of recent traces. It never lists demo visitors' traces, so on the hosted database it
was always empty, and P12 made it redirect to `/demo`. A judge opening the public address landed in the middle of a
demo with no word on what Praman is, who it is for, or why an agent's spending needs a gate.

**Decision.** `/` is a front page rendered once at start from fixed text and the demo's own config: the problem, who it
is for, the steps every purchase goes through, and one real refusal from step 6 of the demo, with two buttons into
`/demo`. It reads no database, runs no script and takes no input, so it answers while Neon is asleep and is not on the
per-address read limit. The index moves to `/traces`, unchanged, and with nothing to list it says so and links to the
demo instead of redirecting. Every link to the index (a non-demo trace's top link, the operator console's back link,
the Postman collection) now points at `/traces`. A browser that asks for an unknown path, or hits a rate limit or a server
error, gets a small page linking to the demo and the front page; a client that doesn't ask for HTML still gets the
plain text it got before.

**Rejected.** Keeping the index at `/` and putting the case at the top of it: on the hosted server the list below would
always be empty. Making `/demo` itself the front page: it already carries eight steps and its own start page, and
someone arriving from a trace link should land back in their story, not on a pitch. Reading live numbers (traces
recorded, chain length) onto the front page: it would wake the database on every visit for a figure a judge can see
in the console.

**Cost.** Anyone who bookmarked `/` for the trace list now has to go to `/traces`. The front page's figures come from
`apps/receipt-ui/src/demo/config.ts`, so it changes only when the demo does; its copy describing the steps has to be
kept true by hand.

### D-78 · On Render the visitor is the third X-Forwarded-For entry from the right · Accepted

An implementer's decision, made on 2026-11-08 from the header the hosted server really received. It settles the question D-60 left open.

D-60 set `TRUST_PROXY=1` without having seen Render's header. On the live site, eight requests with made-up addresses got seven through, and refusals came and went for one client. `2` behaved the same.

A temporary log (`d0be8c6`, since reverted) recorded each header as salted hashes, so no address reached the log. It showed three entries, or four with a made-up one in front. From the left: the made-up entry if any, the visitor (the same on every request and equal to `CF-Connecting-IP`), then two proxy entries that vary between a few values.

**Decision: `TRUST_PROXY=3` on Render.** It uses the mechanism D-60 chose, with the value measured rather than assumed.

**Rejected: reading `CF-Connecting-IP`.** It carries the same value here, but D-60's objection stands: it is only safe while Cloudflare is in front, and a position from the right needs no new code.

**Cost.** If Render changes its proxy chain, the number has to change too. `docs/DEPLOY.md`'s smoke test catches that.

---

### D-79 · The intent row carries the signed mandate, so a dispute bundle can be checked from outside · Accepted (implementer's decision, for the builder to check)

The dispute bundle said `signature_verified: true` with no mandate in it, inferred from the decision's reason code, and `issuer` was always `null`. Someone outside Praman had nothing to check. Mandates aren't stored anywhere the ledger can reach, and the demo's live only in memory.

**Decided.** After `verifyMandate()` passes, `runIntent` writes the signed mandate (document and signature) and the public key it verified against onto the `intent` row. The bundle reads them back, recomputes the Ed25519 signature, fills `issuer` from `issuer_id`, and says `signature_check: "recomputed"`. Traces from before this change say `"inferred"`, and that is all they can say.

**What it opens.** Anyone holding a trace id can now read that mandate's limits in its bundle. The MCP gateway's answers never carry payloads (`traceEvents` strips them), so an agent with only the gateway still can't see limits. An agent that can also fetch the receipt server's `dispute_url` can read them, which D-08 doesn't cover. On the hosted demo the visitor sees those limits on the page anyway. A real deployment would put `/dispute` behind an access check.

**Limit.** The public key travels with the bundle, so it proves the mandate wasn't altered after signing, not who holds the key. Tying a key to a person is a key registry, which Praman doesn't have.

**Rejected.** The unused `mandate` table: outside the hash chain, so no tamper evidence. A new ledger event: more rows on every trace and no gain over a field on the row that already belongs to the decision. A signing step in the demo: it would change what a visitor does, not what an outsider can check.

---

### D-80 · Since 2026-11-07 an independent agent reviews changes, not the builder · Accepted (the builder's decision, recorded by an implementer for the builder to check)

D-27 said each change to `evaluate.ts` and the hash chain needed the builder's review, and the README repeated it. On 2026-11-07 the builder changed how the project runs, in `CLAUDE.md` (invariant 3 and Working style): agents make all code changes and commits without waiting for him, and independent agent reviewers check the money path. No later record said so, which left the README's provenance statement false.

**Decided.** The review a change gets is an independent agent's. A change to `evaluate.ts` still needs a failing test first and its own commit, and the builder is told in plain language what changed and why. Invariant 1 doesn't change: no model takes part in a payment decision at runtime.

**Consequence.** The trust D-27 rested on the builder's reading now rests on the failing test, the isolated commit, the independent review and the CI checks. Agents' own design calls are marked as implementer's decisions in this file, for the builder to check afterwards. Dated records, such as older build log entries, are left as they were.

