# Build Log

Running record of what broke, what I decided, and why. Written daily, not
reconstructed. Raw — the polished version is the submission write-up.

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
  erased at compile time, so it gives zero runtime enforcement — but amounts
  enter Praman from exactly four enumerable boundaries, each with its own
  runtime check. A class would survive erasure at the cost of allocation per
  amount and rehydration through every ORM and clone boundary. Not worth it
  for four known entry points.

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