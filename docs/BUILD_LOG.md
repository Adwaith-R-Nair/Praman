# Build Log

Running record of what broke, what I decided, and why. Written daily, not
reconstructed. Raw — the polished version is the submission write-up.

Entries are dated and are not retroactively edited. Where a later day proves an
earlier entry wrong, the correction is recorded forward rather than by rewriting
the original. A log that gets quietly amended isn't evidence of anything.

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

## Day 8 — 4 Sep 2026 · append, derive, verify, and three bugs only Postgres could show me

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

## Day 9 — 4 Sep 2026 · mandate, catalog, idempotency, execution

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

## Day 10 — 4 Sep 2026 · the Razorpay guarantees that weren't

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

## Day 11 — 4 Sep 2026 · closing Block A, opening the agent

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

## Day 12 — 4 Sep 2026 · the agent, live

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
- D-23 formalises the eval split forced by the numbers from Day 11: the free
  tier's real 15 RPM / 500 RPD budget makes running a full adversarial corpus
  through a live model impractical to iterate on, but almost none of that
  corpus needs a live model in the first place — a malicious intent can be
  constructed directly and fed to `runIntent`, deterministic and free. Only
  the prompt-injection family genuinely requires a model in the loop, because
  a hand-built intent has no model to influence. The harness itself is Block
  D work, not built yet.