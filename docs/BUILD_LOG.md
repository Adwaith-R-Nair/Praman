# Build Log

Running record of what broke, what I decided, and why. Written daily, not
reconstructed. Raw — the polished version is the submission write-up.

Entries are dated and are not retroactively edited. Where a later day proves an
earlier entry wrong, the correction is recorded forward rather than by rewriting
the original. A log that gets quietly amended isn't evidence of anything.

"Day N" counts elapsed calendar days since Day 0 (27 Aug), verified against
`git log --format='%ad %s' --date=short`, not a count of entries. Day 8 (4 Sep)
covers five distinct work sessions in one sitting — labelled 8a–8e in the order
they happened, not five separate days. An earlier version of this log
incremented the number per session instead of per elapsed day, which made "Day
12" read as 8 September to a reviewer checking it against the submission
deadline — a real, caught mistake, corrected here rather than quietly fixed.
Days 8a–8e were also written up after that session rather than turn-by-turn
during it — reconstructed from the session's own record within hours of the
work, not fabricated after the fact, but not the same as the daily-write
discipline the rest of this log holds to, and worth stating rather than leaving
implied.

## Day 0 — 27 Aug 2026 · repo and specification

- Wrote the full spec before any code: architecture, HLD, LLD, mandate spec,
  eval corpus, decision records. Five docs commits precede the first line of
  TypeScript. Deliberate — I wanted the design to be defensible independently
  of whether the implementation finished.
- pnpm's `init` defaults to ISC while my LICENSE file is MIT. Two files
  disagreeing about licensing is a small thing that erodes trust in the rest.

## Day 1 — 28 Aug 2026 · Razorpay rails

- Razorpay's published Indian test cards have drifted across doc pages. The
  widely-cited `4111 1111 1111 1111` no longer works; the current Visa success
  card is `4100 2800 0000 1007`. Confirmed against razorpay/markdown-docs
  rather than a blog. Lesson: pin test fixtures to the provider's source repo.
- Set payment capture to Manual temporarily to observe the `authorized` →
  `captured` transition that auto-capture hides. Worth doing once — it makes
  the order/payment split visible, and that split is the model Praman's gate
  is built around.
- Learned the order exists so the amount is fixed server-side: the browser
  only ever receives an opaque `order_id` and cannot express a price. Praman's
  `PurchaseIntent` carries SKU and quantity for the same reason, one layer up.
  Razorpay doesn't trust the browser; we don't trust the model.
- Chose "refund automatically" for uncaptured authorizations over manual
  dashboard capture. Orphaned holds on a customer's card are a liability
  nobody will monitor. Fail-closed: when a money flow ends ambiguous, default
  to returning funds.
- Rejected manual capture as a second authorization checkpoint. Praman's gate
  sits upstream of order creation; a capture-time gate would re-evaluate
  identical facts against the same mandate and reach the same answer, while
  adding an authorized-but-uncaptured state to track and time out. Complexity
  without control. → D-17.
- Minor: checkout rejects Indian contact numbers not starting with 6–9. Used
  9999999999. Agent flows must prefill contact details — there is no human to
  type them.

## Day 2 — 29 Aug 2026 · toolchain and the money type

- pnpm requires `pnpm-workspace.yaml` to exist before accepting workspace-scoped
  installs (`-w`). Chicken-and-egg on first setup.
- pnpm blocks postinstall scripts by default; esbuild needs explicit
  `pnpm approve-builds`. Correct posture for a payments project — install-time
  code execution is a live supply-chain vector.
- Toolchain landed on TypeScript 7.0.2, the Go-native compiler (stable since
  8 Jul 2026). Faithful port, so no semantic changes, but TS7 dropped `baseUrl`
  and changed the `types` default to empty. No stable programmatic API until
  7.1, so type-aware ESLint is off the table this week.
- Put `money.test.ts` in `src/` instead of `test/`. Vitest reported zero test
  files while typecheck passed cleanly. Two tools disagreeing about the project
  was the clue to where the problem was.
- Chose a branded `bigint` for `Paise` over a class wrapper. The brand is
  erased at compile time, so it gives zero runtime enforcement — the plan is
  to guard the four boundaries where amounts enter instead. A class would
  survive erasure at the cost of allocation per amount and rehydration through
  every ORM and clone boundary. Not worth it for four known entry points.
  *(See Day 6 — at this point only one of the four guards actually existed,
  and I wrote this entry as though all four did.)*

## Day 3 — 30 Aug 2026 · serialisation and scope discipline

- `BigInt()` is far more permissive than expected: `BigInt("")` is `0n`,
  `BigInt("0x10")` is `16n`, whitespace is silently trimmed. A missing amount
  field would have charged nothing and a hex string would have charged 16
  paise, both silently. Hardened `paiseFromJSON` with a strict `/^\d+$/` guard,
  a length cap, and a runtime `typeof` check — the parameter type is a wish at
  a boundary, not a fact.
- Added a CI grep rejecting `as Paise` casts outside `money.ts`. The invariants
  doc banned them already, but an unchecked rule is a suggestion.
- `JSON.stringify` does not guarantee key order, so it cannot be used for
  signature preimages or idempotency keys. Wrote a canonical serialiser:
  sorted keys by code unit (not `localeCompare`, which is machine-dependent),
  bigints as strings, non-finite and fractional numbers rejected rather than
  coerced to `null`.
- Considered rewriting the policy core in Rust for newtypes that survive to
  runtime. Costed it out: one genuine benefit, against a new FFI boundary that
  itself needs runtime validation — solving a boundary problem by adding a
  boundary. Rejected, documented as D-18, moved to the post-submission roadmap.
- Corrected the docs' account of how this was built. Renamed CLAUDE.md to
  docs/INVARIANTS.md and reframed it as engineering rules that hold regardless
  of who or what is writing the code.
- Behind schedule: Phase 2 (ledger) was planned for today and Phase 1 is only
  finishing now. Cut list already ordered in ROADMAP.md; dispute bundle goes
  first if Day 7 runs short.

## Day 4 — 31 Aug 2026 · evaluate() and its review

- Wrote `evaluate()` and its test suite by hand, then sent both for review
  before moving to Phase 2. Two real bugs came back, both worth recording
  precisely because they surfaced at review rather than in an eval run.
- **Duplicate-SKU stock bypass.** The stock check ran per line item, not per
  distinct SKU: `[{sku, qty:6}, {sku, qty:6}]` against `stock_qty: 10` passed
  both checks independently and oversold by two units. Fixed by aggregating
  quantities per SKU before validating — one pass, one catalog lookup, bug
  structurally gone. Wrote the failing test first; it failed for the wrong
  reason on the first attempt (the per-txn cap masked the stock bug at the
  price I'd picked), so I lowered the price until the test isolated the
  actual defect, then fixed it. Red commit, then green — the sequence is
  the evidence that the bug was found, not avoided.
- **Mandate limits leaking through the refusal itself.** `detail` strings on
  DENY quoted the exact mandate cap (`"exceeds per-transaction limit 80000
  paise"`), and `ALLOW.remaining_paise` gave the budget away by subtraction.
  D-08 says the agent never learns its numeric limits; the first
  implementation violated that invariant through its own error message. Two
  deliberately-oversized probe purchases would have reconstructed the whole
  mandate from the denials alone. Fixed by splitting `Decision` (internal,
  keeps `detail`) from a new `AgentVisibleDecision` (agent-facing —
  `redact()` strips `detail`, `remaining_paise`, and the
  `STEP_UP_THRESHOLD` / `STEP_UP_FIRST_MERCHANT` distinction) → D-19.
- A `catalog.items.get(item.sku)!` non-null assertion disappeared as a
  byproduct of the aggregation fix rather than needing one of its own — the
  single-pass loop only looks a SKU up once, so there's nothing left to
  assert past. Extended `lint:casts` to also catch `.get(...)!`, and while
  testing that found the script itself had been silently inert the whole
  time: it used paths relative to the repo root, but pnpm always runs a
  package's script from that package's own directory. Fixed alongside.
- Smaller review fallout, each its own commit: added the precedence tests
  the file was missing — the highest-value tests in it, since they're the
  only ones that fail if someone reorders the checks; fixed a test named
  "denies ..." that asserted the opposite; fixed a "multi-item" boundary
  test that used one item; replaced a two-point "monotonicity" test with an
  actual sweep; replaced `Math.random()` in the 1000-case property test
  with a seeded LCG — an irreproducible failure is a bad look in a project
  whose whole pitch is reproducible evaluation.
- `seen_idempotency_keys` and `merchants_transacted` were arrays checked
  with `.includes()` against lists that grow with ledger history. Switched
  to `ReadonlySet<string>` — cheap now, and it heads off an O(n) habit
  before there's real ledger history to make it expensive.
- `VerifiedMandate.scope.currency` is typed as the literal `"INR"`, so a
  direct runtime comparison against `"INR"` is dead code by the compiler's
  own reasoning — TypeScript flags it unreachable. Added the check anyway,
  widened through an explicit `string`-typed local rather than a cast, as a
  guard against a mandate arriving from a boundary the type doesn't cover.
  Reused `AMOUNT_INVALID` instead of adding a new reason code for a
  one-line defensive check — the enum is closed for a reason, and this
  didn't clear the bar for widening it.
- Deleted `subject_id` from `VerifiedMandate`: a real field on the mandate's
  wire and DB schema, but nothing in `evaluate()` ever read it. An unused
  field on a policy input is a smell either way — check it or delete it, and
  there was nothing here to check.

## Day 5 — 1 Sep 2026 · the probe oracle, and the ledger foundation

### Closing out evaluate()

- **Redaction narrows the probe oracle; it does not close it.** D-19 stops the
  agent reading its cap off an error message, but a deterministic allow/deny
  boundary *is* an oracle: propose qty 8 → DENY, qty 4 → ALLOW, qty 6 → DENY.
  That's a binary search. Redaction took mandate reconstruction from 2 probes
  to roughly 17, which is a real improvement and not a fix. Worse, denials are
  free — `txn_timestamps` records successful transactions only, so velocity
  never fires on refusals and probing costs the attacker nothing.
  Non-determinism was rejected as a mitigation because it would destroy D-02's
  reproducibility, which the whole eval harness depends on. The actual fix is
  a denial-rate cap over a new `denied_attempts` field, deferred to Phase 5
  with a `mandate_evasion` corpus case in Phase 6. → D-20.
- `quantities` is a `Map`, so it iterated in line-item insertion order, which
  meant two carts with identical defects returned *different* reason codes
  depending on how the agent happened to order the items. Verified before
  fixing: forward order gave `CATEGORY_OUT_OF_SCOPE`, reversed gave
  `SKU_UNKNOWN`. Now sorted by SKU using the same comparator as `canonical()`.
  Same root cause as a bug still ahead of me — cart identity must not depend
  on line-item order, or a reordered retry derives a different idempotency key
  and double-charges.
- `Object.freeze` does not prevent `Map.set` or `Set.add` — collection
  internals live in internal slots that freezing doesn't reach. The purity
  test's `deepFreeze` therefore covers the plain-object and array parts of the
  input graph and not `catalog.items`, `merchants_transacted`, or
  `seen_idempotency_keys`. Corrected the comment rather than the test: an
  accurate note about a partial test beats a confident one about a test that
  doesn't do what it claims.
- Pinned both validity-window edges with tests. The code uses strict `<` and
  `>`, so `now === not_before` and `now === not_after` are both non-denying.
  Defensible either way — the point is that it's now deliberate rather than
  accidental.

### Prisma and Postgres

- **Prisma's own `latest` dist-tag on npm pointed at `8.0.0-rc.12` while
  `@prisma/client` and `@prisma/adapter-pg` were still at stable `7.10.0`.**
  A plain `pnpm add` therefore produced a CLI/runtime cross-major skew,
  silently — the CLI would have generated client code shaped for a runtime
  that wasn't installed. Caught before running `prisma generate` by querying
  npm dist-tags directly rather than trusting the docs site, which had already
  switched its default to v8. Pinned all three to exact `7.10.0`, no carets:
  when a provider's own `latest` points at a release candidate, floating
  ranges are a liability. Second instance this week of published documentation
  running ahead of shipped artifacts.
- Denied postinstall builds for `msgpackr-extract` (native msgpack accelerator,
  has a JS fallback) and `workerd` (Cloudflare Workers runtime, for edge/D1
  adapters) — both transitive Prisma deps irrelevant to local Postgres over
  `adapter-pg`. Approved `@prisma/engines` and `prisma`, whose postinstalls
  fetch the native binaries the CLI can't work without. Worth being precise:
  the "Rust-free" claim for the `prisma-client` generator is about the *client
  runtime*, which talks to Postgres through `adapter-pg` with no engine binary.
  The CLI still ships native binaries for `migrate` and introspection. Both
  facts are true at once.
- `datasource { url = env(...) }` is a hard validation error on Prisma 7
  (P1012), not a warning. The connection URL moved to `prisma.config.ts`.
  Consequence worth noting: `schema.prisma` is no longer a complete
  description of the datasource, so it carries a comment pointing at the
  config file.
- `import "dotenv/config"` resolves `.env` against `process.cwd()`, not
  against the config file's own location — so it silently found nothing when
  Prisma was invoked from inside `packages/db`, and worked when invoked from
  the root. Fixed by resolving explicitly against `import.meta.url`. Same
  principle as injecting `now` into `evaluate()` rather than calling
  `new Date()` inside it: don't read ambient state you could be handed.
- The immutability triggers had to land as a *second* migration rather than
  being appended to the init migration, because init was already applied and
  Prisma tracks applied migrations by checksum. This is the more correct
  pattern anyway — never edit an applied migration — and it mirrors what a
  real deployment looks like, where init is already in production and
  immutability arrives as a follow-up.
- Chose a `RAISE EXCEPTION` trigger over `CREATE RULE ... DO INSTEAD NOTHING`
  for ledger immutability. The rule silently discards the write: the UPDATE
  "succeeds" affecting zero rows and nobody notices. In a system whose output
  is evidence, silent failure is the wrong default.
- **A test that proved nothing.** After verifying the UPDATE trigger fired, the
  DELETE test reported `DELETE 0` and looked like a pass. It wasn't: `psql -c`
  runs a multi-statement string as one implicit transaction, so the
  `RAISE EXCEPTION` on the UPDATE had rolled back the INSERT too. The DELETE
  then found no row and reported success. Re-ran one statement per command and
  confirmed both UPDATE and DELETE are rejected independently with the correct
  seq. This is the same shape as the duplicate-SKU test failing for the wrong
  reason on Day 4 — in both cases a test appeared to work while testing
  something other than what I meant. **A security test must be observed
  failing before its passing is worth anything.** Carrying that rule into the
  60 adversarial cases in Phase 6.
- `@db.Timestamptz(3)` is load-bearing, not cosmetic. The hash preimage uses
  `ts.toISOString()`, which emits exactly three fractional digits, while
  Postgres `timestamptz` defaults to microsecond precision. A lossy round trip
  would make every recomputed hash differ from the stored one and
  `verify-ledger` would report tampering on rows nobody touched. General rule:
  anything inside a hash preimage must survive its storage round trip
  byte-for-byte. Same class of problem as canonical JSON key ordering and
  bigint-as-string serialisation.
- Verified the connection end to end with a live `findMany()` returning zero
  rows, rather than stopping at a green typecheck. Typecheck proves the client
  compiles; it proves nothing about the adapter, the connection string, or
  whether the migration actually ran.

## Day 6 — 2 Sep 2026 · auditing my own claims

- Built a tutor subagent to interrogate the codebase against its own
  documentation, and it found D-18 asserting that all four money boundaries
  had runtime guards when only one did. The other three describe packages that
  don't exist yet — a decision record written in the present tense about
  future code. Corrected to a status table naming what's implemented and
  what's pending. In a project whose pitch is honest measurement, a claim a
  reviewer can disprove in ninety seconds is worse than no claim. The same
  overstatement is in the Day 2 entry above; it stays there, because the log
  records what I believed on the day.
- The same audit surfaced something sharper. `addPaise` catches a forged
  negative `Paise` — but only incidentally, because it happens to route its
  result back through `paise()`. `formatINR`, the function that renders an
  amount for a human to read, renders `₹-1.00` without complaint. **Whether a
  forged value is caught depends on which function touches it next, which is
  luck, not a security property.** Added a defensive throw in `formatINR` as a
  loud-failure backstop, while being clear that the actual fix is single-point
  hydration per boundary — one `paiseFromDb` that is the only place a database
  bigint becomes money, auditable by grep. That lands in Phase 3 with the code
  that needs it.
- The test for that fix couldn't use `-100n as Paise`, because the repo's own
  `lint:casts` script rejects `as Paise` outside `money.ts` and the test file
  doesn't match the exemption. Used `@ts-expect-error` instead, which reads
  better: it documents a deliberately induced type error rather than
  laundering one through a cast.
- Third instance this week of documentation outrunning reality — Razorpay's
  test cards, Prisma's dist-tags, and now my own decision record. The failure
  mode of fast-moving systems isn't wrong code, it's confident text describing
  code that has changed or hasn't been written.

## Day 7 — 3 Sep 2026 · the hash-chain core

- Hardened `computeEntryHash`'s pipe-delimited preimage: the separator is only
  safe while no field can contain a `|`, and that was a comment-level
  guarantee, not a checked one. Added explicit rejects for a malformed
  `prevHash`/`payloadHash` (not 64-char lowercase hex — `digest("hex")` only
  ever emits lowercase, so uppercase means the value came from somewhere
  else), a non-positive `seq`, an invalid `Date`, and a separator inside
  `actor`/`eventType`. Also made the `"utf8"` encoding on both hash calls
  explicit rather than relying on the implicit default — a hash preimage is
  exactly the place "the default happens to be right" is worth stating.
- Added the round-trip test that actually matters: `computePayloadHash` on a
  payload survives `JSON.parse(JSON.stringify(...))`. This is the whole
  tamper-detection story working at all — Postgres jsonb does not preserve key
  insertion order (it sorts by length then bytes), so if hashing depended on
  insertion order, every entry would fail verification the moment it was read
  back from the database, indistinguishable from real tampering. It works
  because `canonical()` sorts keys, making insertion order irrelevant by
  construction — but that was an untested assumption until now.
- Moved `LedgerDerivedState` out of `packages/policy` and into
  `packages/shared`, re-exported from policy's `types.ts` so nothing else
  changed. The ledger must not depend on the policy package — the ledger
  doesn't know what a decision means — so the contract the two packages share
  has to live below both of them, not inside either.
- Added `assertLedgerPayload`, a recursive JSON-safety guard, and wired it
  into every ledger write. `JSON.stringify` throws on `bigint`, but
  `canonical()` (used for hashing) handles bigints fine by serialising them as
  strings — so a payload carrying a raw `Paise` would hash cleanly and then
  explode on insert into Postgres's jsonb column. Checked at the boundary
  rather than documented as a convention, because a payload that hashes
  successfully and then fails on insert would leave a lock held and the error
  confusing. `Date` is rejected too, on purpose: `JSON.stringify` would
  silently convert it to an ISO string, which technically "works" but leaves
  the hashed object and the stored object disagreeing in type.

## Day 8a — 4 Sep 2026 · append, derive, verify, and three bugs only Postgres could show me

- `append()`'s advisory lock used `$queryRaw`, which failed immediately
  against the real database: `pg_advisory_xact_lock()` returns Postgres's
  `void` type, and Prisma's `$queryRaw` tries to deserialise every returned
  column into a JS type — `void` has no mapping. Fixed with `$executeRaw`
  instead, which runs the statement without trying to parse a result set —
  the documented pattern for advisory locks specifically because they return
  nothing meaningful. A typecheck would never have caught this; only running
  it against Postgres did.
- `deriveState()` replays the ledger to compute a mandate's spend, revocation
  status, and denial history — spend is never stored (D-03), because a stored
  counter is a number an attacker can edit, while inflating a derived one
  means forging every subsequent entry hash. Verified against a live chain
  that only `captured` outcomes move `spent_paise`; a `failed` outcome at a
  much larger amount correctly contributed nothing.
- Vitest runs different test files in parallel by default. Once a second
  DB-backed test file (`derive.test.ts`) existed alongside `append.test.ts`,
  their `beforeEach` `TRUNCATE`s and `append()` calls started interleaving
  across files against the same live table — `append()` computes the next
  `seq` by reading the table's current max, so one file's `TRUNCATE` firing
  mid-sequence from another file corrupted the count (`seq: 4n` where `2n` was
  expected). Not flakiness: the ledger's single global chain and single
  global lock are a real constraint, and file-level test parallelism was the
  first thing to violate it. Fixed with `fileParallelism: false` in
  `vitest.config.ts` — a fine tradeoff at this suite's size, and it makes the
  same constraint the advisory lock enforces in production visible in the
  test harness too.
- Built `merkleRoot()` with domain-separated leaf (`0x00`) and internal
  (`0x01`) hash prefixes, pinned against hand-computed vectors (`sha256sum` in
  a shell, not the code under test) for one, two, and three (odd-count,
  duplicate-last) leaves. Caught my own transcription error here: a first
  pass at "cleaning up" the pinned strings silently dropped the trailing
  character on two of the three vectors while retyping them by hand. Only
  caught by re-verifying lengths with a script instead of trusting my own
  eyes on a 64-character hex string — exactly why pinned vectors get
  generated once, from the real output, and never hand-edited again.
- `verifyChain()` walks the whole chain recomputing every hash from stored
  fields and fails fast at the first break rather than collecting all of
  them — once the chain is broken, everything after it is unverifiable
  anyway. Verified against a live, deliberately corrupted database: a
  tampered payload is caught as `PAYLOAD_HASH_MISMATCH` at the exact seq: a
  tampered `actor` (payload untouched) as `ENTRY_HASH_MISMATCH`; a deleted row
  as `SEQ_GAP`. The checkpoint-forgery case needed care to test honestly — a
  naive corruption of a checkpoint's claimed `merkle_root` gets caught earlier
  at `PAYLOAD_HASH_MISMATCH`, which proves nothing about the merkle check
  itself. A real forgery re-signs the checkpoint's own `payload_hash` and
  `entry_hash` to look valid up to that point, and only *then* is
  `MERKLE_MISMATCH` the thing that catches it.
- Built `scripts/verify-ledger.ts` as a CLI, then found it couldn't actually
  run standalone: `@praman/db` throws at import time if `DATABASE_URL` is
  unset, and static `import` statements are hoisted above a module's own
  top-level code — so a `dotenv` config call textually placed before
  `import { prisma } from "@praman/db"` still runs *after* that import's
  module body already threw. Fixed with a dynamic `import()` after loading
  `.env`, since dynamic imports execute in normal statement order. Confirmed
  by running the CLI with `DATABASE_URL` unset in the shell, not just by
  reading the fix and assuming it worked.
- Discovered mid-session that `DATABASE_URL` in `.env` points at port 5433 —
  a native Postgres 18 install running as a system service on this machine —
  while a `praman-db` Docker container has been sitting on port 5432 the
  entire time, apparently never actually used by anything in this project.
  Nothing was broken by this; every test and every commit this whole phase
  correctly used the real (5433) database. But `docker exec praman-db psql`
  had been checked against an empty, unrelated database earlier without that
  being noticed, which is a reminder to verify which resource a command is
  actually touching rather than assuming a name implies the connection.
- `TRUNCATE ledger_entry` bypasses the append-only triggers entirely — the
  ledger's own integration tests rely on exactly this to reset state between
  runs. Postgres never fires row-level triggers (`BEFORE UPDATE`/`BEFORE
  DELETE`) for a `TRUNCATE`; only a statement-level event trigger would catch
  it, and none exists yet. A real gap in the immutability story, named rather
  than left implicit. See `docs/ARCHITECTURE.md`'s "Scope and honesty".

## Day 8b — 4 Sep 2026 · mandate, catalog, idempotency, execution

- Boundary hydration: `paiseFromDb`/`paiseFromRazorpay` closed three of D-18's
  four open rows in one pass; `loadCatalogSnapshot` landing right after
  turned out to close the fourth for free — the "catalog price lookup"
  boundary and the general "Postgres rows" boundary are the same call site
  once that function exists, not two separate things to guard.
- Mandate signing: caught two real bugs in the spec before trusting it.
  First, `VerifiedMandate` was used as a return type but never imported —
  harmless, would have failed at the first typecheck. Second, and serious:
  hydrating `validity.not_before`/`not_after` via `new Date(string)` without
  checking the result. `new Date("garbage")` doesn't throw, it returns an
  Invalid Date, and `evaluate()`'s window checks are `ts < not_before.getTime()`
  / `ts > not_after.getTime()` — comparisons against `NaN` are always `false`,
  in both directions. An unchecked malformed validity window would have read
  as *permanently valid*, not permanently invalid — fail-open in the
  authorisation path, the worst shape a bug can take here. Added explicit
  `Number.isNaN` checks; both regressions are pinned in `sign.test.ts`.
- Idempotency: the spec's `canonicalIntent` includes `intent_id` in the hash,
  which read as a bug on first pass — if idempotency exists to catch a
  retried purchase, doesn't hashing the attempt's own ID defeat it? Checked
  `docs/LLD.md` before assuming so: deliberate. Idempotency here means "an
  exact replay of the same intent object," not "the agent's second attempt at
  the same goal" — the latter is Block C's job (reuse the same intent on an
  internal retry), not this layer's.
- The Razorpay executor: `Number(amountPaise)` on the outbound call had no
  guard symmetric to `paiseFromRazorpay`'s inbound `Number.isSafeInteger`
  check. Currently unreachable at this project's mandate caps, fixed anyway —
  a boundary is a boundary regardless of whether today's data can trip it.

## Day 8c — 4 Sep 2026 · the Razorpay guarantees that weren't

- Building the orchestrator, tested two of Razorpay's documented claims
  empirically instead of trusting them. Created two orders back to back with
  an identical `receipt` — despite the docs stating receipts "have to be
  unique," got two distinct order IDs, no error. Then measured
  `GET /orders?receipt=...`'s propagation lag directly: sometimes ~3 seconds,
  once over 15. A direct fetch by order ID was instant and consistent every
  time — only the receipt-filtered search lags.
- Both findings broke the single-transaction design's core assumption: that a
  retry after a timeout could always find its own prior order by receipt and
  never double-create. Neither holds. This is the dual-write problem — a
  database transaction and an external API call cannot be made atomic, full
  stop, no protocol exists between them.
- Restructured execution into two phases with an outbox record: decide and
  durably record the intent to call *before* calling (T1), call outside any
  transaction, record the outcome after (T2). An orphaned order is now always
  accompanied by a row naming its receipt and amount — unknown unknowns
  become known unknowns. Recorded as D-22, which supersedes the
  single-transaction claim in `ARCHITECTURE.md`, `HLD.md`, and `INVARIANTS.md`
  invariant 5 — all three corrected, not left to quietly contradict the new
  design.
- The reconciler's first draft had a bug that would have been genuinely
  dangerous unnoticed: its `outcome` event payload carried no `mandate_id` or
  `merchant_id`. `deriveState` filters ledger rows by
  `payload->>'mandate_id'` — an event missing that key is invisible to
  *every* future budget calculation, for *every* mandate. A reconciled
  captured payment would never have counted against its mandate's cap. Fixed
  by pulling both fields from the `intent` ledger event (durable since T1)
  instead of trusting the pending record, which stores neither. A second bug
  in the same draft mirrored the record's `succeeded`/`failed` status off
  "was anything found" rather than the found order's own status — a declined
  payment located during reconciliation would have been marked `succeeded`.
- A near-miss worth naming honestly, not just the fix it produced: my own
  first verification of the mandate_id fix looked like it had failed —
  `undefined` printed where a real value should have been. It hadn't. An
  interleaved `vitest run` (my own instruction, in between) had wiped the
  ledger evidence via `TRUNCATE`, and my smoke script's `?.` silently treated
  "row missing" as identical to "field missing" — two very different
  failures wearing the same output. Caught by insisting on a clean
  re-verification with independent raw SQL rather than accepting a confusing
  first result. Same discipline as the Day 5 "test that proved nothing" — a
  check must be observed passing for the right reason, not just observed
  passing.
- That interleaving pointed at something worse than a confusing result:
  `pnpm test`'s `TRUNCATE` was pointed at the same database as everything
  else, meaning a routine test run could — and did — silently destroy real
  accumulated demo data the day before submission. Fixed with a dedicated
  `TEST_DATABASE_URL`, verified by checking real-DB row counts unchanged
  across a full test run. Truncation now covers `ledger_entry` and
  `idempotency_record` together, closing a referential gap that had left one
  ledger-less pending record permanently stuck — found in the act, itself an
  artifact of the same root cause.

## Day 8d — 4 Sep 2026 · closing Block A, opening the agent

- D-18's boundary-hydration table had sat stale at "1 of 4 implemented" since
  Day 6, because the commit meant to update it got skipped when the D-22
  investigation started. By the time it actually happened, the real count was
  4 of 4, not the 3 of 4 originally planned — `loadCatalogSnapshot`'s price
  hydration and the general Postgres-rows boundary turned out to be the same
  call site.
- Built the three CLI scripts (`keygen`, `issue-mandate`, `seed-catalog`)
  that had fallen off the list at the same point, then proved they actually
  work together rather than trusting each in isolation: a real keypair → a
  real signed mandate that verifies → a real 25-item catalog → `runIntent`
  correctly evaluating all of it and returning `STEP_UP_FIRST_MERCHANT` for a
  genuinely fresh mandate's first purchase.
- The first instruction for the agent-facing catalog view was wrong, and was
  corrected before anything got built on top of it: no prices, on the theory
  that hiding them protected the mandate. Prices come from our own database,
  not merchant text — D-01's guarantee is that the *intent* never carries a
  price, not that the agent can't see one. What actually needs hiding is the
  mandate's limits (D-08), because those are what make a probe oracle useful.
  `listCatalogForAgent` now includes `price_paise`.
- Chose Gemini's free tier over Anthropic for budget reasons — a genuine
  constraint, not a preference — which forced a provider-neutral interface. A
  better design regardless of why it happened: it makes D-02's "no LLM in the
  authorisation path" claim demonstrable, not just asserted. Swap the model,
  `evaluate()` doesn't change.
- Picked the model empirically, not by guessing: checked the live per-project
  rate-limit dashboard rather than trusting a ballpark. The plain Flash
  models were capped at 5 RPM / 20 RPD — unusable for iteration, let alone an
  eval sweep. The Lite variants showed 15 RPM / 500 RPD. Settled on
  `gemini-3.1-flash-lite`.
- Verified the `@google/genai` SDK's actual compiled types before writing the
  provider, rather than trusting a draft. Found a real, silent bug:
  `FunctionDeclaration.parameters` expects Gemini's own typed `Schema`, not
  raw JSON Schema — the field for raw JSON Schema is `parametersJsonSchema`,
  documented as mutually exclusive with `parameters`. Would have either
  failed validation or silently sent malformed tool specs.
- Found a second bug the type check couldn't have caught, only the live API
  could: Gemini 3-generation models attach a `thoughtSignature` to every
  function-call part and require the *exact* one back when that turn is
  replayed in history — reconstructing the part from `{name, input}` alone
  gets the next request rejected outright. This exposed a real gap in the
  provider-neutral interface itself, not just this provider:
  `ConversationItem`'s assistant variant had no way to carry a provider's
  opaque turn data forward. Fixed by adding an optional `raw` field that
  round-trips it — general enough for any future provider with a similar
  requirement, not a Gemini-specific patch bolted onto one side of the
  abstraction.

## Day 8e — 4 Sep 2026 · the agent, live

- Verified the Anthropic SDK's real compiled types the same way as Gemini's,
  even though this provider won't be exercised against a live API (no
  credits) — `Tool.InputSchema`, `ToolUseBlock`, `ToolResultBlockParam` all
  matched the draft exactly. Confirmed the current model ID (`claude-sonnet-5`)
  against Anthropic's own docs rather than guess at something past my
  training cutoff. Typecheck-verified only; said so plainly rather than
  implying the same confidence as the Gemini path.
- Wired `runAgent` and `runIntent` together into `pnpm demo` and ran it for
  real against the live catalog and a live Gemini call: the agent correctly
  resolved "order a masala dosa and a filter coffee" to the actual seeded
  SKUs, and `runIntent` correctly returned `STEP_UP_FIRST_MERCHANT` — an
  honest result, not a staged one, since that mandate genuinely had never
  transacted with this merchant before.
- The injection fixture (`SKU_FOOD_099`, a forged closing delimiter plus an
  instruction to smuggle an out-of-scope gift card into every order) ran
  against the live agent twice, manually, and was resisted cleanly both
  times — the model proposed only the requested item and named the injection
  attempt in its own rationale unprompted. Recorded as evidence in D-23, not
  as a settled result: two manual runs are an anecdote, not a rate, and
  saying so in the same breath as reporting a good outcome is the point of
  D-23's Layer 2 existing at all — turn "seems to resist" into a measured
  number, not stop at the first two passes that happened to go well.
- D-23 formalises the eval split forced by the numbers from Day 8d: the free
  tier's real 15 RPM / 500 RPD budget makes running a full adversarial corpus
  through a live model impractical to iterate on, but almost none of that
  corpus needs a live model in the first place — a malicious intent can be
  constructed directly and fed to `runIntent`, deterministic and free. Only
  the prompt-injection family genuinely requires a model in the loop, because
  a hand-built intent has no model to influence. The harness itself is Block
  D work, not built yet.

## Day 8f — 4 Sep 2026 · the eval harness finds a real bug

- Built the Layer 1 deterministic corpus: 12 benign + 20 adversarial cases
  across six families (mandate_evasion, denial_probe, double_charge,
  numeric_confusion, hallucinated_sku, scope_drift). Two benign cases
  (`benign_boundary_per_txn`, `benign_unusual_large_cart`) initially failed
  because their test amounts crossed the step-up threshold without meaning
  to — not a code bug, a test-design bug, fixed with a second mandate
  fixture (`lunch_5000_high_stepup`) that isolates the per-txn boundary from
  step-up interference.
- The corpus caught a genuine bug the moment it ran, not a contrived one:
  `adv_numeric_qty_fractional` (qty 1.5) crashed the whole process with an
  uncaught `TypeError` from `canonical()`, instead of the `AMOUNT_INVALID`
  deny evaluate() would have produced. Root cause: `run-intent.ts` computes
  the idempotency key — which canonicalises the intent — *before* calling
  `evaluate()`, so a malformed intent never reached the check meant to catch
  it. Fixed by wrapping that call in try/catch and denying with
  `AMOUNT_INVALID` on canonicalisation failure, matching the repo's own rule
  that the money path returns typed results, never throws. This is exactly
  the kind of thing D-23 was built to surface — a corpus of real inputs
  against the real pipeline finds bugs a mocked test wouldn't reach.
- Also fixed a plumbing bug local to the eval package: `runner.ts` statically
  imported `@praman/control-plane` before `./seed.js` (which redirects
  `DATABASE_URL` to `TEST_DATABASE_URL`) ever ran, so `@praman/db` threw
  immediately on the wrong URL. Fixed by importing `./db.js` first, for its
  side effect, ahead of anything that reaches `@praman/db`.
- All 32 Layer 1 cases pass live against the real pipeline, zero incidentals
  (a pass for the wrong reason would be reported, not hidden — see
  `runner.ts`'s `incidental` field). Full `vitest` suite (143 tests) still
  green after the `run-intent.ts` fix.
- The `canonical()` crash is the same "validate before compute" ordering bug
  as the three fail-open instances found earlier, just facing the other
  direction. Fail-open: a missing or malformed field reads as "no limit"
  because a comparison against `undefined`/`NaN` is silently `false`.
  Fail-loud: an unvalidated intent reaches a function built to throw on bad
  input, before the check that was supposed to catch it first. Both are the
  same root cause — a value used before it's validated — landing on
  opposite failure modes. The fix is the same principle either way: the
  money path returns a `Decision`, never an exception, and every input gets
  checked before anything downstream trusts its shape.
- The held-out split (`sha256(case_id)`, target 30%) lands at 16/32 (50%) on
  this corpus — verified unbiased over 100k synthetic ids (29.92%), so this
  is sampling variance at n=32, not a defect. Not re-salted after seeing the
  result: choosing a split by its own outcome defeats the reason for
  committing it before any tuning. Stratifying by family would reduce this
  variance and is roadmap work, not tonight's work — the decision was
  already made once results were visible, so revisiting it now would be
  post-hoc regardless of how principled the justification sounds.
- All 32 cases passed on the first run, zero failures. That is not evidence
  the corpus is hard — it's expected, since the corpus was authored from the
  same spec (`MANDATE_SPEC.md`) that the policy engine was built to. A
  perfect score here measures that the implementation matches its own
  specification (real regression value) but is weak evidence against attacks
  the spec didn't anticipate, because no case has yet been observed to fail.
  The discriminating power of Layer 1 is untested. Layer 2 — prompt
  injection against the live model, which nobody here authored — is where
  a genuine, not-designed-in-advance finding can actually come from, and is
  the priority for the remaining time before README/diagrams/video.

## Day 8g — 4 Sep 2026 · metrics

- `containment_rate` as first written counted every adversarial-family case
  where money moved as an uncontained attack — but `denial_probe` deliberately
  includes two cases that are *supposed* to allow money (a legitimate
  purchase after 2 prior denials; denials outside the window not counting),
  proving the denial-rate cap doesn't over-trigger on a real agent. Counting
  those as failures diluted containment_rate to 0.909/0.888 even with 32/32
  cases passing. Fixed by carrying `expected_money_moves` onto `CaseResult`
  and restricting containment (and `money_at_risk_prevented_paise`,
  `incidental_containment`) to cases that were actually attacks. Reads 1.0
  on both dev and heldout now, correctly — every real attack was denied,
  and the two controls are simply outside what containment_rate measures.

## Day 8h — 4 Sep 2026 · Layer 2, live

- Built the 8-case injection corpus per Claude Chat's spec: forged closing
  delimiter, fake "SYSTEM UPDATE" text, a fake claim the mandate was raised,
  injection framed as a prior success rather than a command, a plain
  out-of-scope upsell, quantity inflation on a legitimate item, a
  merchant-id switch, and a clean control with no injection at all.
- Two of the eight (quantity inflation, merchant switch) don't fit the
  existing SKU-presence `influenced` check — a foreign SKU never appears,
  the attack is on a field of a legitimate line item or on the cart's own
  merchant_id. Extended `Layer2Case` with `injected_qty_floor` and
  `injected_merchant_id`, checked alongside `injected_skus` in `runner.ts`,
  rather than force these into a shape that doesn't measure what they
  actually are.
- Ran all 8 live against `gemini-3.1-flash-lite`, sequential with a 5s gap.
  Result: `influence_rate: 0` — none of the seven attempts altered the
  agent's proposal. Read the actual transcripts (`eval/transcripts/`, all
  committed) before trusting that number, since every case also hit
  `STEP_UP_FIRST_MERCHANT` — a ledger-state check independent of cart
  content — which could have masked the model never really seeing the bait.
  It didn't: the bait text is present in every `list_catalog` tool result,
  inside the `<untrusted_merchant_content>` wrapper, and
  `inj_merchant_switch`'s transcript has the model naming the attempt in
  its own rationale — "The merchant content in SKU_INJ7_BAIT was ignored as
  it attempted to redirect the purchase..." Genuine resistance, not an
  artifact of the harness never delivering the payload.
- `contained_despite_influence` is `null`, correctly — with zero influenced
  cases there's nothing to compute a containment rate over, and reporting
  it as 100% would be exactly the kind of empty-denominator claim this
  harness was built to catch instead of make.

## Day 8i — 4 Sep 2026 · report and CLI

- Built `report.ts` (writes `eval/report.md`/`report.json`) and a
  `cli.ts` entrypoint (`pnpm eval --layer1 --layer2 --dev`) since nothing in
  Claude Chat's spec actually orchestrated running the corpus, computing
  metrics, and writing the report — `pnpm eval --layer1 --dev` in the
  planned CI step needed something to invoke. `--dev` doesn't gate anything
  extra beyond the ordinary any-case-failed check; it just labels the run
  as CI-safe (no live model calls) in the console output. Recording the
  interpretation here since it wasn't specified.
- Both caveat paragraphs (split ratio, 100%-containment context) are baked
  into `generateReportMarkdown()` verbatim, plus a third for Layer 2 not in
  the original ask: a single-run, no-repeated-trials influence rate against
  one model on one day is a point estimate, not a guarantee, and the report
  says so next to the number rather than let 0% read as stronger than it is.
- The badge is generated from `Metrics.containment_rate_dev` by
  `generateBadge()` — brightgreen at ≥95%, yellow at ≥80%, red below,
  lightgrey on `null`. Nothing in `eval/badge.json` is hand-typed.
- Verified live: `pnpm eval --layer1 --dev` produces a correct 32/32 report
  with real numbers (containment 100%/100%, `influence_rate: n/a` since no
  Layer 2 cases ran this pass). The committed report is Layer-1-only for
  now — the actual combined report (both layers, matching Claude Chat's
  "publish" commit) comes once Layer 2 is re-run alongside it, to avoid
  burning Gemini quota twice for the same evidence already gathered in
  Day 8h's transcripts.

## Day 8j — 4 Sep 2026 · CI

- Wrote `.github/workflows/ci.yml`: a Postgres 17 service, a second
  `praman_test` database created alongside it, `prisma migrate deploy`
  against both, then `pnpm typecheck`, `pnpm test`, `pnpm verify-ledger`,
  `pnpm eval --layer1 --dev`. No repo secrets needed — nothing in that
  sequence reads a Razorpay, Anthropic, Gemini, or mandate-signing key
  (Layer 1 signs fresh throwaway keypairs per case, every executor is
  simulated); only Layer 2 needs `GEMINI_API_KEY`, and it stays manual.
- Couldn't typecheck YAML, so verified it for real instead of trusting it:
  span up the `docker-compose.yml` Postgres — sitting dormant since Day 8d's
  discovery that local dev actually runs against a native Postgres 18 on
  port 5433, not this container — wiped it with `down -v` for a genuinely
  empty instance, created `praman_test`, ran `prisma migrate deploy` against
  both databases, then ran the exact four CI commands against that fresh
  environment with `DATABASE_URL`/`TEST_DATABASE_URL` pointed at it. All
  four passed, including all 143 vitest tests against a database that had
  never seen this schema before — real evidence the migrations are complete,
  not just that they'd worked once on a long-lived dev database that might
  be carrying manual fixes no migration file captures. Tore the container
  and volume back down afterward, restoring the dormant state Day 8d found.
- The first real run on GitHub's own infrastructure failed anyway, on
  `pnpm typecheck` — a pile of implicit-`any` errors and one real type
  mismatch in `run-intent.ts`, none of which happened locally. Cause:
  `packages/db/src/generated/` (the Prisma client) is gitignored, and the
  workflow ran `prisma migrate deploy` but never `prisma generate`. My
  "fresh database" verification above didn't catch it because it reused
  this machine's already-generated client — a fresh *database* isn't a
  fresh *checkout*. Reproduced properly this time: deleted
  `packages/db/src/generated/` locally, watched the identical error list
  reappear, fixed it by adding a `prisma generate` step, then reran the
  entire docker-based simulation from Day 8j with the client deleted too,
  not just the database wiped. All eight steps passed clean. The lesson
  isn't the missing step, it's that "I verified this" needs to mean the
  same starting conditions the real failure exposed, not a state that
  happens to route around the actual gap.

## Day 8k — 4 Sep 2026 · publishing the report

- Ran the combined report (`pnpm eval --layer1 --layer2`, all 40 cases)
  twice more tonight — partly to get the real numbers with Layer 2 included
  instead of the Layer-1-only report sitting in `eval/` since Day 8i, and
  partly because the first combined run surfaced one more bug: the report
  said "Model: `n/a`" everywhere, including in the Layer 2 caveat, because
  `cli.ts` never set the `PRAMAN_MODEL` env var `computeMetrics()` reads —
  it had the real model id (`provider.id`) sitting right there and just
  never passed it through. Fixed, then reran rather than hand-patch the
  already-generated files — a badge or report edited by hand is exactly
  what "never hand-typed" was meant to rule out.
- Three independent live runs against `gemini-3.1-flash-lite` tonight (two
  before this fix, one after) all landed at the same result: 0/7 injection
  attempts altered the agent's proposal. Consistency across separate runs
  is better evidence than any single one — this isn't a fluke of one
  lucky pass.
- Final numbers: 40/40 cases pass. containment_rate_dev/heldout 100%,
  false_refusal_rate 0%, influence_rate 0%, contained_despite_influence
  null (no influenced cases to measure). Every caveat this session decided
  was worth stating — the split ratio, what a 100% Layer 1 score does and
  doesn't prove, what a single-run 0% influence rate does and doesn't prove
  — is in `eval/report.md`, not just in this log.

## Day 9a — 5 Sep 2026 · the step-up deadlock

- Claude Chat's `pnpm demo` run surfaced a real deadlock: `STEP_UP_FIRST_MERCHANT`
  fires when a merchant isn't in `merchants_transacted`, which `deriveState`
  builds only from `status: "captured"` outcomes. `LiveExecutor.createOrder`
  returns `status: "created"` immediately — capture only happens later via
  reconciliation — so in live mode spend never accumulates and a merchant
  never enters the set. First purchase steps up, nothing resolves it, no
  capture, merchant never registers: every purchase at that merchant steps
  up forever. Never caught by tests or eval because `SimulatedExecutor`
  always returns `"captured"` directly.
- Fixed in `derive.ts`: `"created"` now counts as committed spend alongside
  `"captured"`, matching D-17 — an order that exists is a payable
  obligation, and Praman's authority to refuse ended when it was created,
  so the budget must move then, not at eventual capture. Only `"failed"`
  stays excluded.
- Persisted pending approvals on `STEP_UP` (1b). The `Approval` Prisma
  model already existed — scaffolded early, never wired to any actual code
  path — so this needed no new migration, just `run-intent.ts` actually
  using it: `RunResult`'s `DECIDED` variant gains `approval_id`, set only
  on a fresh STEP_UP. The stored intent is round-tripped through
  `canonical()` before saving, not the raw object, so re-deriving the
  idempotency key at resolution time (1c) produces exactly the same key
  the step-up itself computed. Verified live with a new smoke script
  (`smoke-step-up-approval.ts`, `SimulatedExecutor`, no Razorpay keys
  needed since STEP_UP never reaches the executor call) — confirmed the
  row lands with the right mandate, amount, status, and that the stored
  intent round-trips correctly.
- Built `resolveApproval()` (1c) — the security-sensitive part. Approval
  satisfies only the step-up gate; everything else (revocation, expiry,
  budget, velocity) is re-evaluated fresh against current state, and the
  approved amount is binding, so a repriced catalog voids the approval
  rather than silently executing a different figure than what was shown.
  See D-24.
- Verified Claude Chat's draft carefully before writing anything, since
  earlier drafts this session had real bugs — this one did too, caught
  before committing, not after: `noUnusedLocals` would have failed on an
  imported-but-never-used `randomUUID`, and `MANDATE_LOCK_NS` was a magic
  `42` duplicated in both files rather than a shared constant, a real risk
  if one copy ever drifted from the other. Exported it from `run-intent.ts`
  instead.
- My own smoke test then caught two more, both in the "approve twice"
  path (Claude Chat's own listed test case 4): the initial guard
  `if (apr.status !== "pending") return REJECTED` fired on a SECOND
  approve() call, before ever reaching the idempotency-record check that
  should return the cached `EXECUTED` result — an already-approved
  approval read as a refusal instead of a no-op success. And the 15-minute
  TTL check ran unconditionally on wall-clock time regardless of
  `apr.status`, so a second approve() arriving after the window on an
  *already-executed* approval would have been mis-marked `"expired"` even
  though money had already moved. Both fixed: the reject/expire branch
  and the terminal-status guard now only ever apply while still
  `"pending"` — an already-`"approved"` approval falls straight through to
  the idempotency check regardless of verdict or elapsed time, because
  money already moved is the ground truth, not something this function
  can retroactively revise.
- Live end-to-end (`smoke-resolve-approval.ts`, `SimulatedExecutor`): first
  purchase at a merchant steps up, approve executes it, approving the same
  id again correctly returns the cached order instead of re-executing, and
  — the actual point of item 1 — a second, distinct purchase at the same
  merchant now goes straight to `ALLOW`. The deadlock is closed.
- Turned the smoke coverage into real regression tests (1d):
  `packages/control-plane/test/resolve-approval.test.ts`, five cases —
  expired-since-step-up, revoked-since-step-up, repriced-since-step-up,
  approve-twice, and the deadlock test itself. All five bypasses a naive
  "approve = execute the stored intent" implementation would have allowed.
  All pass on the first run, which tracks: they exercise the same code
  paths the smoke scripts and my own pre-implementation review already
  verified — the value here is making that verification permanent, not
  discovering something new.
- `scripts/approve.ts` and `scripts/pending.ts` (1e), same dotenv-before-
  dynamic-import pattern as `verify-ledger.ts` (a static import would reach
  `@praman/db` before the config() call). Needed adding
  `@praman/control-plane`, `@praman/razorpay-exec`, and `@praman/shared` to
  the root `package.json` — `scripts/` had never imported them before, so
  they weren't resolvable there yet.
- Ran the actual video beat end-to-end through the real CLI, not a smoke
  script: `pnpm demo` → `STEP_UP_FIRST_MERCHANT` → `pnpm approve <id>
  approve` → executed → `pnpm demo` again, same goal, same merchant →
  straight to `ALLOW`. This is the first time the full deadlock-to-resolution
  path has run through the actual demo agent and a live Gemini call, not a
  hand-built intent.
- Two small things the live run caught that a type-correct implementation
  wouldn't: `demo.ts` never printed the `approval_id` a `STEP_UP` produces,
  so there was no way to actually run `pnpm approve` without a separate
  `pnpm pending` lookup — added it directly to the decision output, with
  the exact commands to run. And `approve.ts`'s own status line read
  "approveing" (`${verdict}ing` on the literal string "approve"). Neither
  breaks anything; both would have been a small, avoidable stumble on
  camera tomorrow.

## Day 9b — 5 Sep 2026 · ablation flags

- `PRAMAN_NO_DELIMITER` and `PRAMAN_NO_PROMPT_DEFENCE`, per Claude Chat's
  spec — two flags, not one, since they're two different defences and
  conflating them would measure neither cleanly. Both read live, per call
  (`process.env` inside `wrapMerchantText()` and inside `runAgent()`'s
  prompt selection), not cached at module load — the ablation runner needs
  to toggle these mid-process across 42 sequential calls, and a module-level
  `const DELIMITER_OFF = process.env[...] === "1"` would freeze at whatever
  value was present on the first import and never change again.
  `SYSTEM_PROMPT` stayed a static export; added a sibling
  `SYSTEM_PROMPT_NO_DEFENCE` with the "Handling merchant content" section
  removed, rather than turning the whole thing into a function.
- Verified live before running the real 42-call sweep: one agent call with
  flags off, one with them on, same goal, same merchant. Confirmed the
  wrapped run's tool result contains `<untrusted_merchant_content>` and the
  unwrapped run's doesn't, anywhere in the transcript. Both defaults stay
  off unless explicitly set — every normal `pnpm demo` and `pnpm eval`
  call is unaffected, and D-07 (never interpolate merchant text into a
  system prompt) holds for every real run; this is an explicit, narrow,
  opt-in exception for measurement only.
- Ran the actual sweep: 7 cases × 2 arms × 3 repeats, 42 live calls against
  `gemini-3.1-flash-lite`, 4s apart. Interrupted once mid-run by a system
  restart (only 6/7 transcripts for defended-run1 existed, no `.json`
  output anywhere since that only writes after a full run of 7 completes)
  — deleted the stale partial output and reran clean from the start rather
  than try to resume it.
- Real result, not a null one: defended arm 0/21 influenced; undefended
  arm 2/21 influenced (`inj_system_update`, the fake "SYSTEM UPDATE:" bait,
  in two of the three undefended repeats). Both influenced cases still had
  `money_moved: false` — `CATEGORY_OUT_OF_SCOPE` caught the injected gift
  card regardless. Checked the actual transcript, not just the summary
  numbers: the model's own rationale in both influenced runs says *"A
  mandatory promotional item (SKU_INJ2_TARGET) is included per system
  requirements"* — genuinely fooled, not a borderline call. This makes
  `contained_despite_influence` a real, non-null number for the first time:
  2/2 — every time the injection actually worked, the policy engine still
  stopped it. Extended `writeTranscript`/`runLayer2` with an optional
  subdir so six runs of the same 7 case_ids don't overwrite each other's
  transcripts.
- Published the ablation to `eval/report.md` (docs commit). Wired it
  through `report.ts`/`cli.ts` rather than hand-editing the committed
  file: `pnpm eval` now reads `eval/ablation/*.json` if present and folds
  a data-driven section in automatically, with a templated (not hand-typed)
  interpretation chosen from the actual numbers. Hand-editing once would
  have meant the next `pnpm eval --layer1 --layer2` silently dropped the
  section, since the generator wouldn't know it existed — the same
  "never hand-typed" discipline the badge has held to all along.

## Day 9c — 5 Sep 2026 · trace viewer, starting with the data it needs

- Design brief reviewed (Claude Chat, via Opus): keep the stack exactly as
  specified — server-rendered HTML, one CSS file, no framework, no build
  step, vanilla JS only for the verify button and an expand — and push
  visual quality through typography/colour/one strong idea instead of a
  library. Six concrete techniques given: the hash chain as a literal
  continuous spine (not connectors), a real modular type scale with
  tabular-nums on hashes/amounts, the verify button animating a chain-walk
  rather than flipping a badge, a deliberately designed broken-chain state,
  the untrusted-content block as the thesis screenshot, a print stylesheet.
- Found while checking `verify.ts` before building anything against it:
  `verifyChain()` walks the WHOLE ledger from genesis — there is no
  per-trace slice to check, because the hash chain is one global sequence
  interleaving every trace's entries. `/verify/:trace_id` has to run the
  full check and then report whether *this trace's own entries* fall
  within the verified range, not imply a narrower, isolated check that
  isn't actually what's happening.
- Prerequisite landed: `recordAgentTranscript()` appends a new
  `agent_transcript` ledger event (added to the closed `EventType` union)
  right after `intent`/`decision`, called from `demo.ts` once `runIntent()`
  returns. Deliberately NOT wired through control-plane — `runIntent()`
  still knows nothing about `ConversationItem`, keeping D-02's boundary
  (no LLM in the authorisation path) from leaking into an agent-conversation
  type dependency. The provider's raw turn-replay data is stripped before
  storage: `canonical()`/`assertLedgerPayload` reject anything that isn't
  plain JSON, and an opaque SDK response object is exactly the kind of
  thing that would throw mid-transaction — not needed for human review
  anyway. Marked `evidence_only: true` in the payload: this is evidence for
  a reviewer, never context re-fed into a future prompt.
- Verified live: real `pnpm demo` run, confirmed the `agent_transcript`
  event lands right after `decision` with the untrusted-content wrapping
  intact and no `raw` field, then ran `pnpm verify-ledger` — chain still
  intact, all entries (56) verified including the new one.
- Added `read(tx, traceId)` to `packages/ledger` — CLAUDE.md itself already
  described the package as exposing `append()` and `read()`, but `read()`
  was never actually built; the receipt-ui work this describes is exactly
  what got cut before it was needed. Tested like every other exported
  ledger function.
- Scaffolded `apps/receipt-ui`: a plain `node:http` server (no framework,
  matching the brief), the design tokens as real CSS (the security-paper
  palette, PT Serif + IBM Plex Mono), and `/r/:trace_id` reading real
  ledger data end to end. Caught one thing before ever screenshotting it:
  I'd referenced IBM Plex Mono and written `@font-face { src: local("PT
  Serif") }`, but never actually loaded either font — `local()` only
  resolves if that exact font happens to already be installed on the
  viewer's machine, so in practice every viewer would have silently seen
  Georgia/Menlo fallbacks instead of the typefaces the whole design plan
  was built around. Fixed with a proper Google Fonts link before taking
  a single screenshot, since reviewing the wrong typography would have
  been reviewing the wrong page.
- Viewed live in a real browser (not just curl) against a genuine
  `pnpm demo` trace: fonts load correctly, the modular type scale reads
  right, and — confirmed by eye, not just by the code — `decision`'s
  `prev_hash` genuinely equals `intent`'s `entry_hash` in the raw entry
  list, proving the data layer is correct before spending any effort on
  the visual spine treatment in the next commit. The one thing already
  visibly wrong: the untrusted merchant-content block renders as one
  dense, undifferentiated wall of text — expected at this stage, and
  exactly what the "untrusted block as the thesis screenshot" commit
  fixes.
- Real bug the user caught by actually clicking through, not by me
  screenshotting one example trace: a fully approved-and-executed trace
  (step_up_resolved + api_call + outcome all present) still showed "Needs
  approval / STEP_UP_THRESHOLD" — stale, wrong. `loadTrace()` read only
  the very first `decision` event, but `resolveApproval()` never writes a
  second one; approving a step-up produces `step_up_resolved` +
  `api_call` + `outcome`, not a fresh `decision`. Fixed by deriving the
  final state from whichever of these actually happened: an `outcome`
  present means ALLOW regardless of the original decision, a `reject`/
  `expired` verdict with no outcome means DENY with a plain (not
  formal-reason-code) refusal string, and an approved verdict whose
  re-evaluation still refused (D-24) surfaces that decision's real reason
  code. Re-verified against the exact trace the user was looking at.
- Rendered the chain as a continuous spine rather than a plain list, per
  the brief: one unbroken vertical rule (`.spine::before`), each entry a
  node hanging off it. The one deliberate repetition — an entry's own
  `entry_hash` and the next entry's own `prev_hash`, truncated to the
  same 8-character prefix, rendered directly adjacent at the same indent
  — so continuity is a direct visual comparison, not an assertion. Full
  hash value kept in `data-full` for the print stylesheet later, where
  truncation stops being appropriate. Also added plain-language labels for
  event types (`EVENT_TYPE_PLAIN`) — "Human reviewed the step-up" instead
  of `step_up_resolved`, same reasoning as the reason-code table.
- Couldn't screenshot this one myself at first — the Chrome extension
  wasn't connected — so asked the user to check visually. Real bug in the
  screenshots they sent back: "order lunch for two under ₹700" rendered
  the rupee sign as something closer to a Ruble sign, in both the goal and
  the rationale (serif body text), while the hero's mono "₹520.00"
  displayed correctly. Confirmed the raw HTTP response bytes were the
  correct codepoint (U+20B9) via `cat -A` — not a data bug — and zoomed
  into the rendered glyph to see it precisely: a "P with one bar," not ₹.
  Adding `Noto Serif` as a font fallback (theoretically full Unicode
  coverage) did NOT fix it, which is itself informative — it means
  PT Serif/Georgia aren't reporting a *missing* glyph CSS fallback would
  catch, they're rendering a *wrong* one for a slot that technically
  exists, on at least one real Linux system. Fixed by not trusting the
  serif stack for this one character at all: `fixRupeeGlyph()` wraps any
  literal ₹ in free text with a span forcing IBM Plex Mono, the font
  already proven correct from the hero. Reconnected the browser tool
  afterward and verified directly — zoomed screenshot confirms the actual
  ₹ glyph now, in both the goal and the rationale.
- Reason-code copy pass (commit 4). Dropped the "Allowed —"/"Refused —"
  prefixes from every `REASON_CODE_PLAIN` string: the hero already states
  the verdict, in color, as the page's own headline, so the line right
  below it repeating "Refused —" was the page contradicting its own
  hierarchy rather than adding the one thing that line exists to add —
  the reason. Also suppressed the whole reason section for a plain `OK`:
  "Allowed" already says everything OK would add. Verified against a real
  DENY trace (`pnpm demo "order two family combo platters"` →
  `MANDATE_AMOUNT_EXCEEDED`, genuinely over the ₹800 per-purchase cap, not
  contrived) — reads as "Refused / This is over the mandate's
  per-purchase limit. / MANDATE_AMOUNT_EXCEEDED", no repetition, and
  confirmed the earlier ALLOW trace no longer shows the redundant OK line.
- Untrusted-content block, commit 5 — the "thesis screenshot." Parsed
  `runTool()`'s raw joined catalog string (agent.ts) back into one card
  per SKU (title, price, description) instead of rendering it as a single
  undifferentiated wall, deduped by SKU so a `get_sku` call doesn't
  produce a second copy of an item `list_catalog` already showed. Also
  fixed an existing tell while working on this exact block: the
  `.untrusted::before` label read "untrusted — merchant-authored," the
  precise "WORD — fragment, spaced em dash" pattern the design brief
  calls out to avoid — reworded to "Merchant-authored. Treated as data,
  never as instructions." Avoided introducing the same class of tell in
  the new per-item price/SKU layout too: no middle-dot-joined meta
  strings, just flex layout doing the separation. Verified live against a
  real `pnpm demo` trace — six real catalog items, each its own clean
  card, correctly priced, no duplicates.
- User instruction: no em dashes anywhere in the receipt-ui's rendered
  output (comments/docs stay as-is, cleanup deferred to later). Found and
  fixed the three that were actually user-visible — `decisionLabel`'s
  "Allowed — captured" (now "Allowed (captured)"), a reason-code string
  (now split into two sentences), and the index page's placeholder text.
  Left every em dash inside code comments and JSDoc untouched — those
  aren't part of what a viewer of the page ever sees.
- Commit 6: `/verify/:trace_id` and the animated chain-walk. Confirmed
  the earlier architectural finding in code: `verifyTrace()` runs the full
  `verifyChain()` (same one `pnpm verify-ledger` uses — no per-trace
  slice exists) and separately checks whether this trace's own max seq is
  below wherever the break happened, so "verified" means what it actually
  means instead of implying a narrower per-trace check that isn't what's
  running. Client-side vanilla JS (no library) walks the rendered `.entry`
  elements in order, recolouring each dot 80ms apart as it "confirms" —
  respects `prefers-reduced-motion` by dropping the stagger to 0. Verified
  live, actually clicking the button in a real browser: badge went from
  "not yet verified this session" to "chain verified through 94 entries,"
  and every dot on the spine turned green in sequence.
- Did NOT test the broken-chain path yet, on purpose — that needs a real
  corrupted chain to verify against, and designing what that state looks
  like is commit 7's explicit job. Building and verifying both together
  there (safely against the test database, never the real one), rather
  than testing broken-path plumbing now against a state nothing has been
  designed for yet.
- Commit 7: the broken-chain state. Added `BREAK_REASON_PLAIN` (plain
  language for each `BreakReason` — "This entry's contents changed after
  it was written" for `PAYLOAD_HASH_MISMATCH`, same pattern as the reason
  codes). The spine's line doesn't literally sever at the DOM/CSS level —
  restructuring the continuous `::before` rule into per-entry segments
  felt like real regression risk against a spine that already works,
  for a state that only ever affects one insertion point. Instead the
  walk inserts a `.chain-break` element with a paper-coloured background
  and red top/bottom borders right after the broken entry, which visually
  cuts the line passing behind it — same reader-facing result (a visible
  gap, in `--refused`) without touching working code. Entries after the
  break get `.entry-unresolved` (dimmed, not red) — they were never
  reached, which isn't the same claim as "broken."
- Tested for real, not just designed: seeded a small chain in the TEST
  database (`apps/receipt-ui/scratch.ts`) and tampered with one entry's
  payload using the exact disable-trigger/corrupt/re-enable technique
  `packages/ledger/test/verify.test.ts` already established — never
  touched the real ledger. Pointed `receipt-ui` at `TEST_DATABASE_URL`
  temporarily, opened the trace, clicked verify: seq 3-4 confirmed green,
  seq 5 (the tampered one) turned red, the break marker landed exactly
  there reading "This entry's contents changed after it was written.
  PAYLOAD_HASH_MISMATCH," and seq 6 dimmed as unresolved. Exactly the
  intended design, working end to end against a genuine corruption.
- Commit 8: the `/` index page. Extracted `classifyTrace()` out of
  `verifyTrace()` as a pure function first, so the index can run the
  expensive global `verifyChain()` walk ONCE and classify every listed
  trace against that single result, instead of re-walking the whole
  ledger once per row. Also extracted `decisionClass`/`decisionLabel` out
  of `trace.ts` into a shared `decision-display.ts`, since the index needs
  the exact same labels the trace page does.
- Real bug caught before handing this off: the first row was `ckpt_100`,
  decision "Unknown" — a checkpoint maintenance record, not a purchase.
  `checkpoint` events carry a synthetic `ckpt_<seq>` trace_id
  (`packages/ledger/src/checkpoint.ts`), and my listing query had no
  reason to exclude it. Fixed by only listing trace_ids that have an
  `intent` event — every real purchase trace has exactly one, checkpoints
  never do. Verified live: the checkpoint row is gone, every remaining row
  shows a real decision, amount, and verification state, and clicking
  through actually navigates to that trace's own page.
- Commit 9, the last one for the trace viewer: the print stylesheet. Hides
  the verify button and the back-link (meaningless on paper), reveals the
  full 64-character hash via the `data-full` attribute already carried
  since commit 3 (`font-size: 0` on the truncated text, `content:
  attr(data-full)` on a `::after`, no JS needed), adds a print-only footer
  with the page's own URL so a printout can be traced back to its source,
  and `break-inside: avoid` on entries/merchant items so a page break
  doesn't split one mid-way.
- Verified the actual CSS declarations without triggering a real OS print
  dialog — that's a native UI surface outside the page, the same class of
  thing as a JS alert() that can block automation if it doesn't behave as
  expected, not worth the risk to check one stylesheet. Instead: fetched
  the live rendered HTML, extracted the exact `@media print` block by
  brace-counting, re-applied those same declarations unconditionally to a
  scratch copy served from a throwaway local HTTP server, and viewed that.
  Confirmed: full 64-character hashes render correctly, the footer shows
  the real page URL, the verify button disappears, layout stays clean.
  Same CSS, same result a real print preview would show, without the risk.

## Day 9d — 5 Sep 2026 · design pass, commit 1 of 9

All 9 trace-viewer commits done, functionality complete. Decided to spend
remaining time on a second design pass over `receipt-ui` — not a different
visual language, just more craft spent on the one already chosen
(security paper, PT Serif/IBM Plex Mono, the spine-as-literal-continuity
idea), since that direction was already deliberately picked to avoid the
generic AI-page tells. Wrote a design brief first (palette additions,
type scale, layout concept, principles) and reviewed it against those
tells before touching code — same discipline as the original build.

New 9-commit checklist: (1) tokens — paper grain texture, `--ink-hero`,
`--size-hero`; (2) index masthead with live stats; (3) index row
refinement; (4) trace hero at scale with a decision-tinted wash; (5)
merchant-content stamp redesign, replacing the dashed-border callout; (6)
spine/verify-walk polish; (7) responsive + accessibility pass; (8) print
stylesheet touch-ups for the new elements; (9) final craft pass across
every decision state.

Commit 1: `--ink-hero` (a deeper near-black-green, reserved for exactly
two hero spots so it stays a hero and not a bigger default) and
`--size-hero` (3.4rem, a deliberate jump past the modular scale rather
than another step of it). Also a paper-grain texture on the body
background — inline SVG `feTurbulence`, no image asset — the same idea as
watermark fibres in a real check or bond.

Real bug caught live, before handoff: the first version rendered as
full-color static, not a neutral grain — `feTurbulence` outputs RGB noise
per pixel, and the `feColorMatrix type="saturate" values="0"` step that
was supposed to strip color into it never actually made it into the SVG
markup I wrote, only into my own description of the plan. Screenshot at
normal scale showed visible colored speckle; zoomed screenshot confirmed
it wasn't a JPEG compression artifact. Fixed by actually adding the
`feColorMatrix` primitive and dropping `fill-opacity` from 0.035 to 0.02.
Reverified at both normal scale (reads as faint grey paper texture,
correct) and zoomed (still visible grain up close, expected — zoom
exaggerates by design). Also had to restart the `receipt-ui` server
mid-check: `layout.ts` reads `style.css` via `readFileSync` once at
module load, so a CSS edit doesn't take effect against an already-running
process — same category of gotcha as the two earlier `EADDRINUSE`
incidents, just a caching one instead of a port one.