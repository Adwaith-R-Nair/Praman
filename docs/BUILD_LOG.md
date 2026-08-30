# Build Log

Running record of what broke and how it got fixed. Written daily, not reconstructed.

## Day 0 — 27 Aug 2026

- Razorpay's published Indian test card list has drifted across doc pages.
  The widely-cited `4111 1111 1111 1111` no longer works; the current Visa
  success card is `4100 2800 0000 1007`. Confirmed against razorpay/markdown-docs
  rather than trusting a blog. Lesson: pin test fixtures to the provider's
  source repo, not to search results.

- Set payment capture to Manual temporarily to observe the `authorized` →
  `captured` transition, which auto-capture hides. Worth doing once: it makes
  the order/payment split visible, and that split is the model Praman's gate
  is built around.

- Chose "refund automatically" for uncaptured authorizations rather than
  manual dashboard capture. Orphaned holds on a customer's card are a
  liability nobody will monitor. Fail-closed: when a money flow ends
  ambiguous, default to returning funds.

- Decided against using manual capture as a second authorization checkpoint.
  Praman's gate sits upstream of order creation; a capture-time gate would
  re-evaluate identical facts against the same mandate and reach the same
  answer, while adding an authorized-but-uncaptured state to track and time
  out. Complexity without control. → D-17.

- Minor: Razorpay checkout rejects Indian contact numbers not starting with
  6-9. Used 9999999999. Prefill contact details in the agent flow — there is
  no human to type them.

## Day 1 — 28 Aug 2026

- pnpm requires pnpm-workspace.yaml to exist before it accepts workspace-scoped
  installs (-w). Chicken-and-egg on first setup.
- pnpm blocks postinstall scripts by default (supply-chain hardening); esbuild
  needs an explicit `pnpm approve-builds`. Relevant posture for a payments
  project — install-time code execution is a real vector.
- Toolchain landed on TypeScript 7.0.2, the Go-native compiler. Semantics are
  a faithful port so no code changes, but TS7 dropped baseUrl and changed the
  `types` default to empty — worth knowing before pasting any older tsconfig.
- Put money.test.ts in src/ instead of test/; vitest found no tests while
  typecheck passed. The two tools disagreeing about the project was the
  clue to where the problem was.