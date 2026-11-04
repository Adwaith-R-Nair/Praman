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

**The rule from here.** Agents may edit both files. Each change needs a failing
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
