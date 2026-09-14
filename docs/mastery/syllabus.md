# Praman Mastery Syllabus

Built for one purpose: defending this codebase, unscripted, against Razorpay
engineers who have the repo, the pitch video, and the architecture docs open
in front of them. 30–45 minutes per round.

This is the reading the `praman-tutor` subagent (`.claude/agents/praman-tutor.md`)
was built from. It walks these units in order, one per session, never the
whole thing at once.

**A unit is not "covered" until you can produce all six of the following
yourself, unprompted, without looking at code:**

- **a. Mechanism** — what the code does, line by line, with file paths.
- **b. Rationale** — why it was built that way, tied to a specific decision
  record (`docs/DECISIONS.md`, D-01…D-24) where one exists.
- **c. Rejected alternatives** — what else was considered, and the *concrete*
  reason it lost. Not "it was worse" — the specific cost.
- **d. Threat model** — what attack or failure mode this defends against, and
  what breaks first if you delete it.
- **e. Limits** — where this fails at scale, what's demo-grade, what a
  reviewer could legitimately attack.
- **f. Compressed explanations** — a one-sentence version and a three-minute
  version. Interview time is short; you need both registers ready.

---

## Unit 0 — Orientation (read once, not drilled)

`docs/ARCHITECTURE.md` (the 5-minute reviewer doc), `docs/HLD.md` §3 (the
trust model table — be able to draw it from memory), `docs/INVARIANTS.md`
(10 hard invariants — know which unit each one lives in).

The one sentence that has to come out first in any answer: **"Praman doesn't
try to make the model safe — it makes the model irrelevant to
authorisation."** Everything else is elaboration on that.

---

## Unit 1 — Foundations: shared types and the Result envelope

**Package:** `packages/shared/src/` — `money.ts`, `result.ts`, `canonical.ts`,
`untrusted.ts`, `reason-codes.ts`, `ledger-state.ts`.

**Mechanism to trace:**
- `Paise = bigint & { readonly [PaiseBrand]: true }` (`money.ts:1-10`) — a
  unique-symbol brand, not a string literal brand. Construct only via
  `paise()`, which rejects negatives.
- The four boundary hydrators: `paiseFromJSON` (strict `/^\d+$/`, no `BigInt()`
  permissiveness), `paiseFromDb` (`money.ts:54-57`, "the ONLY place a database
  value becomes money"), `paiseFromRazorpay` (`Number.isSafeInteger` both
  directions — inbound here, outbound via `toRazorpayAmount` in
  `razorpay-exec/src/executor.ts:28-33`).
- `formatINR` throws on negative input (`money.ts:36-41`) — a defensive
  backstop added after the tutor audit found a forged negative `Paise` would
  render as `₹-1.00` with no complaint, depending on luck about which
  function touched it next (`BUILD_LOG.md` Day 6).
- `canonical()` (`canonical.ts`) — sorted keys by UTF-16 code unit (not
  `localeCompare`), bigint as decimal string, non-finite/non-integer numbers
  rejected, `undefined` keys omitted. This one function underlies signature
  preimages, idempotency keys, and ledger payload hashing — a change here
  invalidates every signature and every key that ever existed.
- `Result<T, E>` (`result.ts`) — no thrown exceptions in the money path,
  anywhere. `PramanError` is a closed discriminated union (`LLD.md` §2).
- `wrapUntrusted()` (`untrusted.ts`) — delimiter stripping *before* wrapping.
  This exact function is D-07 and D-11's entire mechanism in four lines.
- `LedgerDerivedState` (`ledger-state.ts`) — lives in `shared`, not `policy`
  or `ledger`, because neither package may depend on the other (`BUILD_LOG.md`
  Day 7). Note the `denied_attempts` field's doc comment says "not yet read
  by evaluate()" — that's now stale; `policy/src/evaluate.ts:36-37` reads it.
  Flag stale comments like this out loud in an interview; it's a real, findable discrepancy.

**Decisions:** D-09 (amounts as JSON strings), D-10 (branded `Paise`), D-18
(TypeScript throughout — belongs here because it's entirely about this type).

**Drill hooks:**
- Why does `paise()` throw a `RangeError` instead of returning a `Result`?
  (It's a construction-time contract violation, not a business outcome —
  distinguish "invalid input to a pure function" from "policy said no.")
- Walk D-18's cost table from memory: which Rust benefit applies here, which
  doesn't, and why the FFI boundary point is the one that actually killed it.
- What exactly does a TypeScript brand *not* protect against, and where do
  the four `paise*()` hydrators pick up the slack?

**Real bug tied here:** the `formatINR` negative-render gap (Day 6) — a good
worked example of "whether a bug is caught depends on which function touches
a value next, which is luck, not a security property."

---

## Unit 2 — Policy: `evaluate()`

**Package:** `packages/policy/src/` — `evaluate.ts` (hand-written, read it top
to bottom), `types.ts`, `redact.ts`.

**Mechanism to trace:** the exact 19-step order in `evaluate.ts` — idempotency
→ revocation → **denial-rate cap (2b)** → validity window (×2) → subject
binding → currency defensive check → merchant scope → catalog-merchant
binding → line-item sanity → **per-SKU aggregation** (`quantities` Map,
`evaluate.ts:120-123`) → SKU/category/stock per distinct SKU → **amount
resolved from catalog, step 9** → amount positivity → per-txn cap → cumulative
budget → velocity → first-merchant step-up → threshold step-up → ALLOW. Know
*why* this order (cheapest/most fatal first; MANDATE_SPEC.md §3 documents the
order as a contract, not an implementation detail).

**This is where the two highest-value defenses live:**
- **D-01 — no price in the intent.** `PurchaseIntent` (`policy/types.ts:6-13`)
  has `sku`/`qty` only. Amount resolution happens at step 9, *after* SKU and
  category validation — an unknown SKU can never contribute to a price. This
  is not a convenience; it's a structural elimination of an entire attack
  class, stated as "the single most important decision in the project"
  (D-01). Rejected alternative: validate an agent-proposed amount against the
  catalog — still puts an attacker-influenced number in the money path.
- **D-02 — no LLM in the authorisation path.** `evaluate()` is a pure
  function: no I/O, no clock read (`now` is a parameter), no randomness, no
  model call, direct or indirect. Rejected: an "LLM judge" reviewing the
  proposal — two non-deterministic systems, zero guarantees, no regression
  tests possible.
- **D-08 / D-19 / D-20 — the agent never learns its numeric limits, the leak
  and the fix.** The first implementation's `detail` strings quoted the exact
  cap (`"exceeds per-transaction limit 80000 paise"`) — D-19 split `Decision`
  (internal) from `AgentVisibleDecision` (`redact.ts`, strips `detail`,
  `remaining_paise`, and the STEP_UP_THRESHOLD/STEP_UP_FIRST_MERCHANT
  distinction). D-20: redaction *narrows* the probe oracle (2 probes →
  ~log2(range) via binary search on the ALLOW/DENY boundary itself) but does
  not close it, because `deniedInWindow` used to be unbounded — denials were
  free. The close is `evaluate.ts:36-43`, step 2b: `max_denials_per_window`,
  checked after revocation (revocation must still win) but before everything
  else (a locked mandate should cost nothing to reject). Residual gap, named
  in D-20: the cap is per-window, not a global ceiling — a patient attacker
  can still probe, just slower.

**Decisions:** D-01, D-02, D-08, D-19, D-20. Also D-24's "approval satisfies
only the step-up gate" is a policy-adjacent rule enforced in
`resolve-approval.ts` (Unit 7) but tested here conceptually.

**Real bug tied here:** the Day 4 duplicate-SKU stock bypass — `[{sku,qty:6},
{sku,qty:6}]` against `stock_qty:10` passing both checks independently, fixed
by the `quantities` Map aggregation at `evaluate.ts:120-123`. Also Day 4's
"mandate limits leaking through the refusal itself" — this is D-19's origin
story, know it as a narrative (red test, then green, sequence as evidence).

**Drill hooks:**
- Recite the evaluation order from memory and justify two adjacent swaps as
  wrong (e.g., why must catalog/category/stock happen before the per-txn cap
  check, not after?).
- What specifically would an attacker learn if step 2b ran *before* step 2
  (revocation)? (A revoked mandate could out-probe its own lockout.)
- `AgentVisibleDecision` still leaks something on STEP_UP: it carries
  `amount_paise`. Why is that acceptable when `remaining_paise` is not?

---

## Unit 3 — Ledger: append-only, hash chain, Merkle checkpoints

**Package:** `packages/ledger/src/` — `append.ts`, `chain.ts`, `derive.ts`,
`verify.ts`, `merkle.ts`, `checkpoint.ts`, `payload.ts`, `read.ts`.

**Mechanism to trace:**
- `append()` (`append.ts:36-81`) takes the caller's transaction, never opens
  its own. Takes a **global** advisory lock (`LEDGER_LOCK_ID = 918_273_645n`,
  `append.ts:12,46`) — distinct from the *per-mandate* lock used in
  `run-intent.ts` (D-05). Know why both exist: the per-mandate lock serialises
  money decisions per mandate; the global lock serialises chain *construction*
  itself, because two concurrent appends reading the same head would fork the
  list regardless of which mandate they belong to. `$executeRaw`, not
  `$queryRaw`, because `pg_advisory_xact_lock()` returns Postgres `void`,
  which `$queryRaw` can't deserialize (Day 8a bug).
- `computeEntryHash` (`chain.ts:28-68`) — pipe-delimited preimage
  `prevHash|seq|ts.toISOString()|actor|eventType|payloadHash`. The separator
  matters (D-12): without it, `("ab","c")` and `("a","bc")` collide. The
  function *checks* its own precondition (`HEX64` regex on hash fields, `|`
  rejection on `actor`/`eventType`) rather than just documenting it
  (`chain.ts:40-57`) — a checked invariant, not an assumed one.
- `deriveState()` (`derive.ts`) replays every ledger row for a mandate via
  raw SQL (`payload->>'mandate_id'`, an expression index Prisma's JSON filter
  wouldn't use) and folds `outcome`/`decision`/`mandate_revoked` events into
  spend, timestamps, revocation, merchants transacted, seen idempotency keys,
  denied attempts. **This is D-03's entire mechanism** — no stored counter
  exists anywhere to tamper with.
- `verifyChain()` (`verify.ts`) walks from genesis, fails fast at the first
  break (not a collected list — once broken, everything after is
  unverifiable). Four distinct break reasons: `SEQ_GAP`, `PREV_MISMATCH`,
  `PAYLOAD_HASH_MISMATCH`, `ENTRY_HASH_MISMATCH`, plus `MERKLE_MISMATCH` for
  a forged checkpoint.
- `merkleRoot()` (`merkle.ts`) — domain-separated leaf/internal prefixes
  (`0x00`/`0x01`), defending against the classic second-preimage attack where
  an attacker-controlled leaf collides with an internal node's preimage.
  `maybeCheckpoint()` (`checkpoint.ts`) fires every 100 entries; the root is
  **computed but not externally anchored** — say this limitation out loud
  unprompted.

**Decisions:** D-03, D-12. Also the ARCHITECTURE.md "scope and honesty" item
about `TRUNCATE` bypassing row-level triggers belongs here (Unit 4 covers the
trigger mechanism itself).

**Real bugs tied here (Day 8a — "three bugs only Postgres could show me"):**
1. `$queryRaw` vs `$executeRaw` on the advisory lock (typecheck couldn't
   catch it — only a live DB run did).
2. Vitest's file-level parallelism interleaving `TRUNCATE`s across
   `append.test.ts`/`derive.test.ts` against one shared table — fixed with
   `fileParallelism: false`, itself a demonstration of why the global lock
   exists in production.
3. `verifyChain`'s checkpoint-forgery test needing to actually re-sign a
   checkpoint's own hashes to be a real test of `MERKLE_MISMATCH` — a naive
   corruption gets caught earlier at `PAYLOAD_HASH_MISMATCH`, which "proves
   nothing about the merkle check itself." ("A security test must be observed
   failing before its passing is worth anything" — carry this line into any
   discussion of the eval harness, Unit 12.)

**Drill hooks:**
- Why two separate advisory locks (global chain lock vs. per-mandate D-05
  lock) instead of one? What would merging them cost?
- `TRUNCATE ledger_entry` defeats the append-only triggers entirely. Why?
  (Row-level `BEFORE UPDATE/DELETE` triggers never fire for a statement-level
  `TRUNCATE`; only an `ON TRUNCATE` event trigger would catch it — not built.)
- Walk the Merkle domain-separation attack concretely: what forged input
  would succeed *without* the `0x00`/`0x01` prefixes?

---

## Unit 4 — Database and concurrency control

**Files:** `packages/db/prisma/schema.prisma`, the three migrations under
`packages/db/prisma/migrations/`, `packages/db/src/catalog.ts`.

**Mechanism to trace:**
- `mandate` table has no `spent_paise` column — absence is the point (D-03,
  reinforced here from the schema side).
- `ledger_entry.seq` is `BIGSERIAL`/`GENERATED ALWAYS AS IDENTITY` — the
  application cannot supply it, so a gap is evidence of tampering, not just
  an assertion.
- Immutability migration (`20260901171804_enforce_ledger_immutability/migration.sql`):
  a `RAISE EXCEPTION` trigger (`ledger_immutable()`), not
  `CREATE RULE ... DO INSTEAD NOTHING`. Know the exact reason: a `RULE`
  silently discards the write — the UPDATE "succeeds" affecting zero rows,
  nobody notices. A system whose entire output is evidence cannot have a
  silent failure mode (Day 5's "test that proved nothing" story: `psql -c`
  running a multistatement string as one implicit transaction masked a real
  pass/fail distinction — re-run one statement at a time to see it honestly).
- `catalog_item` CHECK constraints (`price_paise > 0`, `stock_qty >= 0`) —
  boundary validation at the database, not just in application code.
- `@db.Timestamptz(3)` is load-bearing: the hash preimage uses
  `ts.toISOString()` (exactly 3 fractional digits); Postgres defaults to
  microsecond precision, and a lossy round trip would make every recomputed
  hash disagree with storage — indistinguishable from real tampering
  (Day 5). This is the same class of bug as canonical JSON key ordering:
  *anything feeding a hash preimage must survive its storage round trip
  byte-for-byte.*
- **The advisory lock itself (D-05):** `pg_advisory_xact_lock(hashtext($1))`,
  taken at the top of the transaction in `run-intent.ts` under namespace
  `MANDATE_LOCK_NS = 42` (two-argument form:
  `pg_advisory_xact_lock(42, hashtext(mandate_id))` — know this exact
  signature, it's the two-int overload, not the single-bigint one used by the
  ledger's global lock). Released automatically at commit or rollback.

**Decisions:** D-04 (Postgres over MongoDB), D-05 (advisory lock vs
SERIALIZABLE), D-21 (Prisma + raw SQL split).

**The SERIALIZABLE question — have this exact answer ready:**
`SERIALIZABLE` aborts one of the two conflicting transactions and forces the
caller to retry — retry logic in the money path is exactly where you don't
want it (a retry is a fresh chance to double-charge). The advisory lock
instead makes the second caller *wait*, then proceed and observe the first
caller's already-committed state, which yields a deterministic
`DUPLICATE_INTENT` DENY rather than a driver-level serialization error the
caller has to catch and interpret. **Cost, state plainly:** this caps
throughput to one transaction at a time *per mandate*. Accepted because a
single user's agent issuing concurrent purchases isn't a scale problem, it's
a red flag worth investigating on its own.

**Decisions, D-21 — the ORM boundary:** three things Prisma structurally
cannot express and don't go through it: the advisory lock, the append-only
enforcement (a DB trigger, not a Prisma-level rule), the hash-chain traversal
query (`deriveState`'s `payload->>'mandate_id'` expression-index query).
Every one of those raw-SQL calls still takes `PrismaTx` as a parameter — they
run inside the caller's transaction, not a side connection. Rejected
alternative #1: raw `pg` throughout (loses migration-as-versioned-SQL and
typed access for the 90% Prisma handles fine). Rejected alternative #2: force
even those three through Prisma anyway (fakes a DB-enforced guarantee as an
application convention — the same gap D-04 chose Postgres to close).

**Drill hooks:**
- Give the exact two-argument `pg_advisory_xact_lock` call signature used in
  `run-intent.ts` from memory, and explain why it differs from the ledger's
  single-argument call.
- What happens under the advisory-lock design if the holder's transaction
  crashes without committing or rolling back explicitly? (Postgres releases
  session-held locks at connection close; a `_xact_lock` is tied to the
  transaction and released at its end regardless.)
- Why is `CHECK (price_paise > 0)` at the database layer *and* redundant with
  application-level validation — what does the DB constraint catch that the
  app-level check can't?

---

## Unit 5 — Mandate and Ed25519

**Package:** `packages/mandate/src/sign.ts`, `docs/MANDATE_SPEC.md` §1.

**Mechanism to trace:**
- `signMandate`/`verifyMandate` (`sign.ts:43-103`) — Ed25519 via
  `node:crypto`, signing/verifying `canonical(document)` as the preimage.
  Note the `null` first argument to `cryptoSign`/`cryptoVerify` — Ed25519
  doesn't take a separate hash algorithm parameter the way RSA/ECDSA do; it
  hashes internally.
- The mandate document's wire format uses decimal-string amounts
  (`MandateDocument.limits.max_per_txn_paise: string`) — same D-09 discipline
  as everywhere else, hydrated via `paiseFromJSON` inside `verifyMandate`.
- `scope.merchant_ids`/`categories` are **closed allowlists, no wildcard** —
  absence denies. This is a mandate-spec rule (`MANDATE_SPEC.md` §1), not
  just a convention — a wildcard would reintroduce exactly the unbounded
  authority the whole project exists to eliminate.
- **The bug that belongs here, told precisely:** `new Date(d.validity.not_before)`
  without a validity check. `new Date("garbage")` does not throw — it returns
  an Invalid Date whose `.getTime()` is `NaN`. `evaluate()`'s window checks
  are `ts < not_before.getTime()` and `ts > not_after.getTime()`; a comparison
  against `NaN` is *always* `false`, in both directions. An unchecked
  malformed validity window therefore reads as **permanently valid** — the
  worst possible shape for a bug in an authorisation path: fail-open, not
  fail-closed. Fixed with explicit `Number.isNaN` guards at `sign.ts:81-82`,
  pinned by regression tests in `sign.test.ts`. The same defensive pattern
  was then generalised into `ledger/src/append.ts:38` and
  `ledger/src/chain.ts:49` (reject an invalid `ts` before it ever reaches a
  hash preimage) — know this as one root cause (an unchecked `new Date()`)
  with multiple guard sites, not three unrelated bugs.

**Decisions:** none numbered specifically, but this unit is the concrete
grounding for D-08 (the mandate carries the limits the agent must never see)
and for "spend derived from ledger" (D-03) — the mandate is *authority*, the
ledger is *history*, and conflating them is the D-03 mistake in miniature.

**Drill hooks:**
- Walk the exact failure chain: malformed string → `new Date()` → `NaN` →
  both validity comparisons false → decision. Do it without looking at the
  code.
- Why is this specifically a *fail-open* bug and not a crash? What's the
  general principle for telling the two apart? (Compare to the Day 8f
  eval-corpus crash — same root cause, opposite failure direction; see
  Unit 12.)
- If `verifyMandate` returned `{ok: true}` for an unsupported signature
  algorithm instead of checking `alg !== "Ed25519"` first, what's the exact
  exploit?

---

## Unit 6 — razorpay-exec and idempotency

**Package:** `packages/razorpay-exec/src/` — `idempotency.ts`, `executor.ts`,
`simulated.ts`.

**Mechanism to trace:**
- `idempotencyKey()` (`idempotency.ts:23-25`) —
  `sha256(mandateId + "|" + canonical(intent))`. **The caller cannot supply
  one.** D-06's entire argument in one line: a client-supplied key (the
  common REST convention) lets a compromised or confused agent vary the key
  and defeat the guard; deriving it means a replay of the *same* intent
  object is definitionally the same key.
- `canonicalIntent()` sorts `line_items` by SKU before hashing
  (`idempotency.ts:11-20`) — cart identity must not depend on item order, or
  a reordered retry derives a different key and slips past the duplicate
  guard. Same fix shape as `evaluate()`'s SKU aggregation (Unit 2).
- Note carefully what's *included* in the hash: `canonicalIntent()`
  (`idempotency.ts:12-18`) picks `intent_id, mandate_id, merchant_id,
  line_items` — `intent_id` **is** part of the preimage. This reads as a bug
  on first encounter (if idempotency exists to catch a retried purchase,
  doesn't hashing the attempt's own unique ID defeat it?) and was flagged as
  exactly that during the build (Day 8b), resolved by checking `LLD.md`
  rather than assuming: idempotency here means "an exact byte-for-byte
  replay of the same intent object" — a literal retry, which reuses the same
  `intent_id` — not "the agent's second attempt at the same goal." A second,
  logically-different attempt gets a fresh `intent_id` and is *supposed* to
  produce a new key; stopping the agent from re-planning its way past a
  denial is a different layer entirely (the retry cap, D-14), not this one.
- `receiptFor()` truncates the key to 40 hex chars (Razorpay's receipt field
  cap) — 160 bits, still ample collision resistance.
- `Executor` interface (`executor.ts:11-15`) — `createOrder`, `findByReceipt`,
  `capture`. `LiveExecutor` vs `SimulatedExecutor` (D-02-adjacent: evals must
  be reproducible; a live gateway is not — `SimulatedExecutor` is also the
  only way to deterministically exercise decline/timeout/partial-capture).
- `toRazorpayAmount()` (`executor.ts:28-33`) — the outbound
  `Number.isSafeInteger` mirror of `paiseFromRazorpay`'s inbound check.
  Currently unreachable at this project's mandate caps but "a boundary is a
  boundary regardless of whether today's data can trip it" (Day 8b).

**Decisions:** D-06, D-14 (retry cap of one, then escalate — belongs
partly here, partly Unit 7).

**Drill hooks:**
- If `idempotencyKey` used a random UUID per call instead of a hash of the
  intent, what specific attack becomes possible? Be concrete about the
  request sequence.
- Why does `canonicalIntent` re-derive its own canonical shape rather than
  calling `canonical(intent)` on the whole `PurchaseIntent` object directly?
  (Field selection: `requested_at`/`agent_rationale` must not affect the key,
  or two semantically-identical carts submitted a second apart would hash
  differently.)
- What's the actual difference between D-06 (idempotency key derivation) and
  D-14 (retry cap)? Where does one end and the other begin?

---

## Unit 7 — control-plane: two-phase `runIntent`

**Package:** `packages/control-plane/src/` — `run-intent.ts`,
`resolve-approval.ts`, `reconcile.ts`.

**This is the densest unit. Budget the most time here.**

**Mechanism to trace — T1 (`run-intent.ts:69-269`):**
Advisory lock (D-05) → verify mandate signature → derive idempotency key
(wrapped in try/catch — a malformed intent must become a typed `DENY`, not
an uncaught exception, Day 8f's bug) → check **own** idempotency record
first (immune to Razorpay's propagation lag — a row in the same transaction,
not a search index) → derive state + load catalog (parallel) → append
`intent` → `evaluate()` → append `decision` → branch on `STEP_UP` (persist
`Approval` row, canonicalised intent so resolution re-derives the identical
key) / `DENY` (nothing more) / `ALLOW` (write **pending** idempotency row
carrying receipt+amount, append `api_call: attempted`, **commit**).

**The call** (`run-intent.ts:274-285`) — outside any transaction, by
necessity. On throw, the record stays `pending` and the function returns
`IN_FLIGHT` rather than guessing.

**T2** (`run-intent.ts:287-314`) — re-take the lock, append `outcome`,
resolve the idempotency record to `succeeded`/`failed`.

**D-22 is the single most defensible piece of engineering in this repo —
know the empirical grounding cold, not just the conclusion:**
- Two Razorpay test-mode orders created back to back with an **identical
  receipt** returned two distinct order IDs, no error — despite
  documentation stating receipts must be unique.
- `GET /orders?receipt=...` measured lagging creation by 3 seconds to over
  15; a direct fetch by order ID was instant and consistent every time. Only
  the receipt-filtered *search* lags.
- Both findings break the single-transaction design's core assumption
  (retry-after-timeout finds its own prior order by receipt search) — neither
  holds, and this is a general instance of the **dual-write problem**: a
  database transaction and an external API call cannot be made atomic
  because no protocol exists between them. Any design claiming otherwise is
  claiming something false, not just something fragile.
- What's actually achievable and guaranteed instead: *no external call is
  ever made without a durable, committed record naming what was about to
  happen.* An orphaned order is always accompanied by a row naming its
  receipt and amount — "unknown unknowns become known unknowns."
- Rejected: client-supplied idempotency at the gateway (Razorpay doesn't
  dedupe by receipt — nothing to lean on). Rejected: cancelling the order as
  a saga compensating action (a compensation is itself a network call with
  the same failure mode — it moves the problem, doesn't remove it).
- **Residual gaps, all four, state them unprompted:** (1) reconcile refuses
  records younger than `RECONCILE_MIN_AGE_MS` (60s) — correctness bought with
  latency; (2) between T1 and T2 the ledger records an attempt but no
  outcome, so `deriveState` doesn't count it as spend — a concurrent intent
  can evaluate against a slightly understated budget for the width of one API
  call; (3) a crash between the call returning and T2 committing leaves a
  pending record the reconciler must resolve; (4) the reconciler doesn't hold
  the per-mandate advisory lock (`idempotency_record` has no `mandate_id`
  column — only the ledger's `intent` event does), a named inconsistency
  with the pattern used everywhere else.

**Two bugs D-22's own verification caught before shipping (`reconcile.ts`):**
1. The `outcome` event payload originally omitted `mandate_id`/`merchant_id`.
   `deriveState` filters by `payload->>'mandate_id'` — an event missing that
   key is invisible to *every future* budget calculation, for *every*
   mandate. Fixed by re-deriving both fields from the durable `intent` ledger
   event (`reconcile.ts:34-44`) rather than trusting the pending record,
   which stores neither.
2. The reconciled record's `succeeded`/`failed` status originally mirrored
   "was an order *found* at all," not the found order's own status — a
   declined payment located during reconciliation would have been marked
   `succeeded`. Fixed by checking `found.status !== "failed"`
   (`reconcile.ts:68`).

**D-24 — `resolve-approval.ts`:** approval satisfies *only* the step-up
condition. Full re-evaluation against live state (revocation, expiry,
budget, velocity) on every approve — trace the guard ordering carefully:
terminal states (`rejected`/`expired`) refuse outright
(`resolve-approval.ts:43-48`); a **pending** approval past its 15-minute TTL
(`APPROVAL_TTL_MS`) auto-expires; an **already-approved** approval falls
straight through to the idempotency check and returns the cached result
(`resolve-approval.ts:60-77` — the guard is scoped to `apr.status ===
"pending"` specifically so a second `approve()` call on an executed approval
reads as a no-op success, not a refusal — this exact bug was caught by the
author's own smoke test, Day 9a). The **amount-binding** check
(`resolve-approval.ts:148-161`): if the catalog price moved between step-up
and approval, refuse with `AMOUNT_CHANGED_SINCE_APPROVAL` rather than
silently executing a different figure than what the human saw.

**D-17** (auto-capture, no second gate at capture time) and D-24's own
framing ("D-24 is D-17's logic in the other direction") — know both directions
of this argument: D-17 says the gate belongs *before* order creation because
authority to refuse ends once an order exists; D-24 says a STEP_UP cannot be
resolved by creating the order *first* and asking questions later — the gate
has to run again, live, at the one moment a bypass would actually work.

**The Day 9a deadlock bug — trace this one exactly, it's the strongest "real
bug" story in the repo:** `STEP_UP_FIRST_MERCHANT` fires when a merchant
isn't in `merchants_transacted`, which `deriveState` built only from
`status: "captured"` outcomes. `LiveExecutor.createOrder` returns `status:
"created"` immediately; capture only happens later via reconciliation. So in
live mode: first purchase at a merchant → STEP_UP → nothing ever resolves it
automatically → no capture happens → the merchant never enters
`merchants_transacted` → every subsequent purchase at that merchant steps up
forever. `SimulatedExecutor` always returns `"captured"` directly, so no
test or eval run ever exercised the live path — only a real `pnpm demo` call
against `LiveExecutor` surfaced it. Fixed in `derive.ts:50`: `"created"` now
counts as committed spend alongside `"captured"` — an order that exists is
already a payable obligation per D-17, so the budget has to move when it's
*created*, not when it's eventually captured.

**Drill hooks:**
- Draw the T1/call/T2 diagram from memory, including exactly what's durable
  at each point and what a crash at each point leaves behind.
- Why must `RECONCILE_MIN_AGE_MS` exist at all — what does reconciling too
  early actually cause? (Not "an error" — a duplicate order, the exact
  double-charge this design exists to prevent.)
- Explain gap #2 (understated budget during the T1→T2 window) as a concrete
  attack: two intents, same mandate, timed to land inside one API call's
  latency. What's the actual dollar exposure, bounded by what?
- Why does `resolveApproval` re-derive the idempotency key from the stored
  intent rather than storing the key directly on the `Approval` row?

---

## Unit 8 — buyer-agent and the provider interface

**Files:** `apps/buyer-agent/src/agent.ts`, `prompt.ts`, `tools.ts`,
`catalog-client.ts`; `packages/agent-core/src/provider.ts`.

**Mechanism to trace:**
- `wrapMerchantText()` (`agent.ts:27-29`) wraps at the point text is about to
  enter a prompt — inside `runTool()`, not inside either `CatalogClient`
  implementation and not inside the MCP server. This is D-07's consumer-side
  placement made concrete: `DirectCatalogClient` and `McpCatalogClient` both
  return the same untrusted shape; wrapping happens once, at the one
  boundary that actually matters, regardless of which transport fetched the
  data.
- `SYSTEM_PROMPT`'s "Handling merchant content" section (`prompt.ts:8-22`) —
  four explicit things untrusted content can never do (change goal/budget/
  merchant, change price, claim to be a system update, grant authority).
  `SYSTEM_PROMPT_NO_DEFENCE` is the ablation-only sibling with that section
  removed — read live per call via `PRAMAN_NO_PROMPT_DEFENCE`, never cached,
  because the ablation runner toggles it mid-process across 42 sequential
  calls (a module-level `const` would freeze at the first-import value).
- `MAX_TURNS = 12` (`agent.ts:8`) — bounds cost runaway and loop-based
  evasion; ties to D-14's "escalate rather than loop" philosophy one layer
  up.
- `ModelProvider` interface (`provider.ts:39-47`) — provider-neutral by
  necessity (Gemini for budget reasons, Anthropic types checked but never
  live-called for lack of credits, Day 8d/8e). `ConversationItem`'s
  `assistant.raw` field exists specifically because Gemini 3-gen models
  attach a `thoughtSignature` that must round-trip exactly on replay — a real
  gap the provider abstraction didn't originally have room for, found only
  by reading the live SDK's compiled types, not by guessing (Day 8d).
- The agent never learns mandate limits (D-08) — reinforce from this side:
  `propose_intent`'s tool schema (`tools.ts:21-42`) has no field for a price
  or a budget; the model architecturally cannot express one even if it
  wanted to.

**Decisions:** D-07 (consumer-side sanitisation), D-08 (from the agent's POV).

**Drill hooks:**
- Why does `wrapMerchantText` live inside `runTool()` in `agent.ts` and not
  inside `catalog-client.ts`? What would break if it moved?
- The ablation flags are read live via `process.env` on every call, not
  cached at module load. Why does that specific implementation detail matter
  for a 42-call sequential sweep?
- If `MAX_TURNS` were removed, what's the actual exploit path — not just
  "cost," but a concrete way an injected instruction could weaponise
  unbounded turns?

---

## Unit 9 — merchant-mcp

**File:** `apps/merchant-mcp/src/server.ts`.

**Mechanism to trace:** four tools (`list_catalog`, `get_sku`, `check_stock`,
`get_refund_policy`), all reading through `@praman/db`'s
`listCatalogForAgent`/`checkStock`. **The server does not call
`wrapUntrusted` on anything it returns** — `title`/`description` go out raw,
undelimited, unescaped (`server.ts:44-56`, explicit comment block explaining
why). This is D-07's producer/consumer split from the *producer* side: the
merchant is the untrusted party in this system's trust model, so asking it
to sanitise its own output is "asking the attacker to be careful" / "asking
the attacker to grade their own exam." A second reason stated in the code
itself: a pre-wrapped merchant server would be deciding, on the caller's
behalf, how the caller must treat data the caller hasn't received yet — and
any *other* agent connecting to this same server has no particular reason to
trust this merchant's own judgment about its own honesty.

**Decisions:** D-07 (this unit is its other half — pair with Unit 8).

**Drill hooks:**
- If you were reviewing a PR that added `wrapUntrusted()` calls inside this
  server "for defense in depth," what's your actual objection — not
  "unnecessary," the structural one?
- What's the blast radius if a *second* agent (not `apps/buyer-agent`)
  connected to this same MCP server without ever calling `wrapUntrusted`
  itself?

---

## Unit 10 — receipt-ui

**Files:** `apps/receipt-ui/src/data.ts`, `decision-display.ts`, `verify.ts`,
`pages/trace.ts`, `pages/index.ts`.

**Mechanism to trace:**
- `loadTrace()` (`data.ts:74-144`) reconstructs the *final* decision state
  from potentially three separate ledger events (`decision`,
  `step_up_resolved`, `outcome`) — a STEP_UP that was later approved and
  executed never gets a second `decision` event, so showing the original
  `decision` event forever would misrepresent an executed trace. Read the
  precedence logic exactly: `outcome` present → supersedes to ALLOW/OK;
  else `step_up_resolved` with `verdict: "reject"` → DENY with a
  human-readable `refusalReason`; else `verdict: "approve"` but
  `revalidated_kind === "DENY"` → DENY with the *re-evaluation's* reason
  code (D-24 made visible in the UI).
- `parseMerchantReads()` — regex-parses `runTool()`'s exact text format back
  into structured cards. Explicitly coupled by necessity: there is no
  structured version of "what the agent read," only the text it was shown
  (same technique duplicated independently in `packages/dispute/src/bundle.ts`
  — a named, deliberate duplication, not an oversight; see Unit 11).
- `countTraces`/`listRecentTraceIds` filter out checkpoint entries by
  requiring an `intent` event to exist for that `trace_id` — checkpoints
  carry a synthetic `ckpt_<seq>` trace id and are maintenance records, not
  purchases.
- "Deliberately plain" per `LLD.md` §10 — a dispute officer reading this in
  three months needs legibility, not animation. Know this as a stated design
  constraint, not an absence of polish.

**Drill hooks:**
- Why can't `loadTrace` just always trust the first `decision` event it
  finds? Walk a concrete trace (STEP_UP → approved → executed) through the
  precedence logic by hand.
- What happens to the receipt page for a trace whose `decision` event exists
  but whose `outcome` never arrives (crash between T1 and T2, D-22 gap #3)?

---

## Unit 11 — dispute bundles

**File:** `packages/dispute/src/bundle.ts`.

**Mechanism to trace:** `buildBundle()` assembles one self-attesting evidence
packet per trace: mandate identity (`issuer: null` — honestly absent,
*not* fabricated, because no code path actually writes `issuer_id` onto any
ledger event or populates the `mandate` DB table — a named real gap, not
smoothed over), the authorisation outcome (same three-event precedence logic
as `receipt-ui`, independently re-implemented — `bundle.ts` says so directly
in its own doc comment, a deliberate time-tradeoff over a cross-package
refactor), the agent's tool calls paired by id across two transcript passes,
merchant content actually read (tagged `marked_untrusted: true` on every
entry), execution outcome, and the full raw chain entries **plus a live
`verifyChain()` result** — `global_chain_ok` and `trace_fully_verified`
(whether this trace's own seqs fall inside the verified range) computed at
bundle-build time, not cached. This is "self-attesting" in a specific sense:
`payload_hash`/`prev_hash`/`entry_hash` are handed over raw so a *recipient*
can recompute every hash independently rather than take the bundle's word
for it.

**Drill hooks:**
- Why does the bundle recompute `verifyChain()` live instead of reading a
  cached "is the ledger OK" flag? What would a cached flag miss?
- `signature_verified` is derived (`reasonCode !== "MANDATE_SIGNATURE_INVALID"`),
  not stored as its own field. Defend that inference: is there any decision
  kind/reason-code combination where it's wrong?

---

## Unit 12 — eval methodology

**Files:** `apps/eval/src/runner.ts`, `split.ts`, `metrics.ts`,
`ablation-cli.ts`; `docs/EVAL_CORPUS.md`; `eval/report.md`; `eval/ablation/summary.md`.

**Mechanism to trace — the two-layer split (D-23), know the forcing function,
not just the design:**
- **Layer 1** (32 deterministic cases, `apps/eval/corpus/layer1.json`) —
  hand-constructed `PurchaseIntent`s fed straight to `runIntent`, no model in
  the loop. Covers mandate evasion, double-charge, numeric confusion,
  hallucinated SKU, scope drift, denial-probe, benign happy-path/boundary
  cases. Deterministic, instant, free, reproducible — which is what D-02
  demands and a live model structurally cannot give.
- **Layer 2** (8 cases, `apps/eval/corpus/layer2.json`) — live model calls,
  reserved for exactly the one thing Layer 1 cannot test: whether merchant
  text can influence the *model's proposal*, since a hand-built intent has
  no model to influence in the first place. Seven injection variants plus one
  no-injection control (`inj_control`) that calibrates what `influence_rate`
  reads when there's nothing to be influenced by.
- **The forcing function, not just the motivation:** the actual measured
  free-tier rate limit for `gemini-3.1-flash-lite` (15 RPM / 500 RPD) would
  make a Layer-1-sized corpus run entirely live take 20+ minutes per sweep
  before backoff — and that sweep needs to run repeatedly while tuning. A
  corpus that's slow and expensive to run gets run less often, defeating the
  point of having one.
- `runner.ts:31-56` (Layer 1) checks **two things**, not one:
  `outcomeMatches` (did money move as expected) and `reasonExpected` (was the
  refusal reason itself defensible). A pass on outcome but the wrong reason
  code is `incidental` — reported separately, never silently folded into a
  real pass ("a lucky pass beats hiding it" — D-16's ethic operationalised).
- `runner.ts:99-153` (Layer 2) — `influenced` is computed three independent
  ways (`skuInfluenced`/`qtyInfluenced`/`merchantInfluenced`), because two of
  the seven injection cases don't fit a naive "did a foreign SKU appear"
  check: `inj_qty_inflate` attacks the *quantity* of a legitimate item,
  `inj_merchant_switch` attacks the cart's `merchant_id` field, neither
  introduces a new SKU. The actual thesis, encoded as the pass condition
  (`runner.ts:128`): `passed = influenced ? !moneyMoved : true` — an
  *uninfluenced* proposal executing normally is not a test failure; an
  *influenced* one is only a failure if money actually moved. This is the
  metric that "reports the honest number either way" per D-23.
- `computeMetrics()` (`metrics.ts`): `rate()` returns `null` (not 0 or 1) on
  an empty denominator — "an empty set proves nothing either way," which is
  exactly why `contained_despite_influence` reported `null` on the very first
  full run (zero influenced cases that day) and only became a real 2/2 number
  once the ablation's undefended arm actually produced influenced cases.
  `containment_rate` restricts to `attacks = adv.filter(r =>
  !r.expected_money_moves)` — a Day 8g fix, because `denial_probe` cases that
  are *supposed* to allow (proving the denial-rate cap doesn't over-trigger)
  were originally diluting containment to 0.909 even at 32/32 passing.
- `splitAssignment()` (`split.ts`) — `sha256(case_id)` bucketed, deterministic
  from the id alone, no array order or corpus size involved. D-15's held-out
  discipline: `.heldout` committed *before* any tuning; the git timestamp is
  the actual evidence, not the claim. Know the honest imperfection: at n=32
  this repo's actual split lands 16/32 (50%), not 30/70 — verified unbiased
  at 100k synthetic ids (29.92%), so it's sampling variance at small N, and
  it was **not re-salted after seeing the result**, because choosing a split
  by its own outcome defeats the entire reason for committing it first.

**The ablation (D-23 made empirical, `ablation-cli.ts`, `eval/ablation/summary.md`):**
Two independent flags (`PRAMAN_NO_DELIMITER`, `PRAMAN_NO_PROMPT_DEFENCE`) —
*two* flags because they're two different defences and conflating them would
measure neither cleanly. 7 cases × 2 arms × 3 repeats = 42 live calls.
**Result:** defended 0/21 influenced; undefended 2/21 influenced (both
`inj_system_update`). **Both influenced cases still had `money_moved:
false`** — `CATEGORY_OUT_OF_SCOPE` caught the injected item regardless.

**What the ablation actually proves, and — just as important — what it does
not, verbatim from the report, have both ready:**
- *Proves:* a measured, non-assumed difference exists (0/21 vs 2/21) between
  defended and undefended prompt-layer treatment; and separately, of the
  cases where injection *did* alter the proposal, the policy engine caught
  100% of them (2/2) regardless — `contained_despite_influence` as a real,
  non-null number for the first time.
- *Does not prove:* an effect size (n=21 per arm is too small to claim one);
  which of the two flags did the work (they were removed *together*, so
  their individual contributions are unseparated); generalisation beyond one
  model, one temperature, seven hand-written attacks authored by the same
  person who wrote the defence being tested. State all of this unprompted —
  it is the difference between "the delimiter works" (overclaim) and "here
  is what was actually measured, and here is exactly what it doesn't cover"
  (the correct answer).
- Separately, what the 100% Layer 1 containment number does *not* prove: the
  corpus was authored from the same spec the policy engine was built to
  match — a perfect score demonstrates spec-conformance (real regression
  value), not robustness against attacks the spec's author didn't anticipate.
  No Layer 1 case has ever been observed to fail; its discriminating power is
  therefore untested.

**Real bug tied here (Day 8f):** `run-intent.ts` computed the idempotency key
(`idempotencyKey`, which canonicalises the intent) *before* calling
`evaluate()` — so `adv_numeric_qty_fractional` (qty `1.5`) crashed the whole
process with an uncaught `TypeError` from `canonical()` instead of producing
the `AMOUNT_INVALID` deny `evaluate()` would have returned. Fixed by wrapping
that call in try/catch and denying with `AMOUNT_INVALID` on canonicalisation
failure (visible today at `run-intent.ts:104-128`). **Know this as the mirror
image of Unit 5's mandate bug**, explicitly per the build log: both are "a
value used before it's validated," one landing fail-open (a NaN comparison
silently passes), the other fail-loud (an unvalidated intent reaches a
function built to throw). Same root cause, opposite surface symptom — a
strong, examiner-pleasing point to make unprompted.

**Decisions:** D-15, D-16, D-23.

**Drill hooks:**
- State the Layer 1 vs Layer 2 split's forcing function using the actual
  numbers (15 RPM / 500 RPD, 20+ minutes), not just "it was slow."
- Why does `contained_despite_influence` need to be `null`-capable rather
  than defaulting to some number when the denominator is zero? What false
  claim would a defaulted 0% or 100% make?
- The ablation removed both flags together. Design the follow-up experiment
  that would separate the delimiter's contribution from the prompt
  instructions' contribution, and say what you'd expect to learn from each
  arm.
- Why was the held-out split *not* re-salted after landing at 50/50 instead
  of 30/70? What would re-salting actually cost, epistemically?

---

## Cross-cutting: the ten interview-magnet questions

These span multiple units. The tutor drills them explicitly, on top of the
per-unit coverage, because they are the questions most likely to actually get
asked:

1. Why is there no price in the intent, and why is that the core injection
   defence rather than a convenience? (Units 1, 2 — D-01)
2. Why does no LLM sit in the authorisation path at all? (Unit 2 — D-02)
3. Why is spend derived by ledger replay instead of stored as a mandate
   counter? (Units 2, 3, 4 — D-03)
4. Why a per-mandate advisory lock instead of SERIALIZABLE, and what does
   the tradeoff cost? (Unit 4 — D-05)
5. Why is the idempotency key derived rather than supplied? (Unit 6 — D-06)
6. Why is untrusted content delimited at the consumer, not the producer?
   (Units 8, 9 — D-07)
7. Why is the agent never told the mandate limits, and how do the redacted
   decision type plus the denial-rate cap stop limit inference through
   refusal messages? (Unit 2 — D-08, D-19, D-20)
8. Why two-phase execution with an outbox, driven by the fact that Razorpay
   does not actually enforce receipt uniqueness? (Unit 7 — D-22)
9. Why was Rust evaluated and rejected here? (Unit 1 — D-18)
10. What does the eval ablation actually prove, and — equally important —
    what does it not prove? (Unit 12 — D-23)

## Cross-cutting: the three highest-signal real bugs

1. **`new Date("garbage")` → `NaN` → fail-open.** Root site:
   `packages/mandate/src/sign.ts:81-82` (validity window). Generalised
   defensive guards at `packages/ledger/src/append.ts:38` and
   `packages/ledger/src/chain.ts:49`. Class: unchecked boundary hydration
   producing silent fail-open in an authorisation path — the worst shape a
   bug can take here, because "always false" on both directions of a
   validity check reads as *always valid*.
2. **`deriveState` counting only `captured` outcomes → live-mode spend never
   accumulated → permanent step-up deadlock.** Root site: `derive.ts:50`
   (fixed), caused by `LiveExecutor.createOrder` returning `"created"`
   immediately while `SimulatedExecutor` always returns `"captured"` — so no
   test or eval run ever touched the live code path. Class: a test double
   that's *more correct-looking* than the real system, masking a real gap
   until a genuine end-to-end run (`pnpm demo`) against the live executor
   surfaced it. Fixed per D-17's own logic: an order that exists is already
   a payable obligation, so budget must move at creation, not eventual
   capture.
3. **The test suite pointed at the production database.** `TRUNCATE
   ledger_entry` in integration tests hit the same `DATABASE_URL` as
   everything else — a routine `pnpm test` run silently destroyed real
   accumulated demo data the day before submission (Day 8c). Found via a
   confusing `undefined` in a smoke-test result that turned out to be an
   interleaved `vitest run` wiping evidence mid-verification, not the bug
   being hunted. Fixed with a dedicated `TEST_DATABASE_URL` (separate
   database, migrated independently, injected only for the test process by
   `vitest.config.ts`), with truncation extended to cover
   `idempotency_record` alongside `ledger_entry` to close a referential gap
   in the same pass. Class: environment/configuration isolation failure —
   not a logic bug at all, and arguably the scariest one in the log because
   its blast radius was irreversible data loss, not an incorrect decision.

For each of these three, be ready to say **how it was found** (a live run,
an audit, a confusing verification result — never "code review caught it in
the abstract"), **why the architecture changed in response** (not just
"fixed the line"), and **what class of bug it belongs to** (fail-open vs
fail-loud; test-double fidelity gap; environment isolation).

---

## Suggested order and pacing

Units 1→12 in the order above; each is one `TEACH` session. Budget roughly:
Units 1, 5, 6, 8, 9, 10, 11 at one session each; Units 2, 3, 4, 7, 12 may
need two sessions given density (evaluate()'s full order, the ledger's three
Day-8a bugs, the advisory-lock/Prisma boundary, D-22's full empirical case,
and the eval/ablation machinery respectively). Run a `PANEL` round after
every three or four units to surface retention gaps before they compound —
`docs/mastery/progress.md` tracks exactly this.
