# Praman for the PayPal AI Hackathon: design

Status: approved by the builder on 2026-11-04.

## Intent

Praman started as a Razorpay AI Buildathon project, and its author was selected for the internship. It now goes further: a submission to the PayPal AI Hackathon, and a project that continues after it.

The goal is to win by making one hard-to-fake claim: **the same mandate format, policy engine and ledger govern an AI agent's spending across payment rails, proven on two.** Razorpay already works. PayPal becomes the second rail, and CI proves that adding it did not change the policy package.

This does not mean one signed mandate spending on both rails. Each mandate has one currency, and if PayPal rejects INR then PayPal runs in USD and Razorpay in INR, which is the expected case.

The two rails are not at equal depth. PayPal goes through checkout, capture and webhooks. Razorpay stops at order creation, as it does today. The README states this, and "any rail" is not claimed.

The product idea stays the same: the model proposes, the policy engine disposes, the ledger remembers. PayPal's Agent Toolkit gives a model tools that act on PayPal directly. Praman is the layer that decides whether that action should happen, and can prove later why it did.

## Hackathon facts this design depends on

Taken from search summaries and third-party listings, because Devpost blocks automated fetching. **The builder should read the [official rules](https://paypalaihackathon.devpost.com/rules) before relying on them.**

- Submission deadline: 2026-11-12 12:00 PT, which is **2026-11-13 01:30 IST**.
- Existing projects are allowed if significantly updated after 2026-10-01, with the update explained. PayPal decides what counts as significant.
- Required: meaningful use of the PayPal developer platform and of AI, a working prototype judges can run or open, a public open-source repo, a project description, and a public YouTube video under 3 minutes.
- Five equally weighted criteria: technological implementation, design, potential impact, innovation, presentation.
- Reported $5,000 special awards include Best Use of Agentic Commerce, Best Use of PayPal + AI and Best Demo Delivery. Render is a reported sponsor with its own award.

## Goals

1. A real PayPal sandbox payment, end to end, governed by Praman.
2. INR and USD both supported, with currency taken from the signed mandate.
3. A hosted demo a judge can use in under a minute with no setup.
4. A demo and video strong enough to compete on design and presentation, not only engineering.
5. An honest public history that makes the post-October work easy to verify.

## Non-goals

- Live-mode keys. Sandbox and test mode only, permanently.
- Removing Razorpay. It stays working, because two rails are the point.
- Roadmap Phases 11 (beyond the statistics item), 12, 14 (public API), 16, 17, 18, 19, 20. They move to after the hackathon and stay in `ROADMAP_PHASE2.md`.
- Currencies other than INR and USD. Zero-decimal currencies stay rejected.
- Foreign-exchange conversion. A mandate is in one currency and is never converted.

## Anti-goals: a failure even if it technically works

- A public endpoint that lets a stranger spend, drain the LLM budget or fill the ledger.
- A claim in the README or video that the repo contradicts.
- A demo that fakes a result. Anything replayed or simulated is labelled on screen.
- Any model output that reaches a price, a limit, a currency or a rail selection.

## Constraints

Invariants 1, 2 (as amended below), 4 to 10 in `CLAUDE.md` still hold. Two changes:

- **Invariant 2 is amended.** All amounts are integer minor units, typed `bigint`, field names suffixed `_minor`, with the currency taken from the signed mandate. The builder updates `CLAUDE.md` and this repo updates `docs/INVARIANTS.md`.
- **Invariant 3 is lifted by the builder's decision** (2026-11-04). The agent may edit `evaluate.ts`. Replacement rules: changes to that file get a failing test first, their own commit, and the builder's review. Docs describe "hand-written" as history: true up to tag `v1.0-submission`, agent-assisted after. Present-tense claims at `README.md:42`, `README.md:209`, `docs/ARCHITECTURE.md:40`, `docs/LLD.md:214` and `docs/PRD.md:97` get corrected, with a decision record explaining the move to an agentic development life cycle.

Commits follow `CLAUDE.md`: proposed by the agent, run by the builder, no trailers.

## Decisions

### Repo and story

Same repo. The README gains a short history: Razorpay Buildathon, then independent learning, then this hackathon. The submission explanation links two comparisons: `v1.0-submission..HEAD`, and the last commit before the window (`51012ef`) to `HEAD`. Commits dated 30 Sep are not claimed as hackathon work.

### Currency

- One amount and one label: `amount_minor` as `bigint`, `currency: "INR" | "USD"`. No parallel paise and cents fields.
- `scope.currency` on a signed mandate is the only source of currency. Region is never used.
- Every catalog item carries a currency. If it differs from the mandate's, `evaluate()` denies with new reason code `CURRENCY_MISMATCH`, added to the enum, docs table and eval corpus. Today nothing stops a ₹500 item (50000 minor units) being read as $500.
- Mandate schema version 2 uses `_minor` names. Version 1 mandates still verify against their original signed bytes and normalise to INR.
- Ledger entries cannot be rewritten. New events use `amount_minor` and `currency`. `deriveState`, the dispute bundle and the trace page read both shapes permanently. A mandate's spend is summed only within its own currency.
- The rename covers about 320 lines in 52 files, in its own mechanical commit. DB columns change by migration, and the append-only triggers on `ledger_entry` are not touched.

### Rails

- `Executor` today is shaped by Razorpay, including `findByReceipt`. It moves to a rail-neutral interface that both `packages/razorpay-exec` and a new `packages/paypal-exec` implement.
- The rail comes from merchant configuration on the server: each merchant has a rail and a currency. It is never in the intent and never from the model. A merchant whose currency differs from the mandate's is denied by the check above.
- Ledger `api_call` and `outcome` events gain a `rail` field. `idempotency_record` gains a `rail` column.
- The idempotency key keeps its derivation from invariant 6. PayPal receives it through the `PayPal-Request-Id` header. Razorpay continues to use the receipt.
- `paypal-exec` converts between `bigint` minor units and PayPal's decimal strings with exact string logic and no floats. Inbound amounts that do not match strictly are rejected. It contains no LLM calls, and the import-boundary check is extended to cover it.
- OAuth tokens are cached in memory, and failures return typed results.

### Payment flow on PayPal

1. Agent proposes a `PurchaseIntent`.
2. T1: `evaluate()` decides and the pending record is written.
3. On `ALLOW`, or after step-up approval, `paypal-exec` creates an order with `intent: CAPTURE`.
4. The buyer approves in PayPal's sandbox checkout.
5. The server captures, with a derived idempotency key.
6. T2 and the webhook append outcomes. The trace page shows the money state.

Create and capture are separate outbox phases, each with its own pending record, so a slow checkout does not look like a stuck call to the 60-second reconciler. `deriveState` counts each idempotency key once, because today it would add the amount again for a second `outcome` on the same payment. D-17's Razorpay auto-capture reasoning does not transfer to this flow, and a decision record says so.

Budget during checkout and on abandonment, and the re-check at capture, are settled under "Decided by the builder" below.

The spike also tests whether a vaulted payment method can be captured with no buyer present. If it works in sandbox, it becomes the second purchase in the demo, because an agent that needs the buyer at PayPal's checkout for every purchase is not very autonomous.

Praman uses the Orders REST API directly in `paypal-exec`, not the Agent Toolkit, because the toolkit hands the model a money-moving tool and that is what Praman exists to prevent. The README says this plainly.

The JavaScript SDK version (v6 is reported as current) is the builder's choice during implementation.

### Reconciliation on PayPal

The reconciler relies on `findByReceipt`, and PayPal's Orders API has no search endpoint. **Settled by the sandbox test (D-26): candidate (a).** The candidates were:

- (a) Repeat the create call with the same `PayPal-Request-Id`, which should return the prior order. If the order never existed it creates a new unapproved one. No money moves until a buyer approves, so this is safe, but the key's retention period is undocumented.
- (b) Search transactions by invoice ID. This only sees captured payments and may lag.

A capture that may have happened is checked by order ID, which is stored after creation. The design rule holds whichever is chosen: an unresolved record keeps holding budget.

### Webhooks (subset of Phase 15)

`POST /webhooks/paypal` verifies with PayPal's verification endpoint or local signature check over the raw bytes before parsing, deduplicates on the event ID, tolerates early and out-of-order delivery, and appends `settlement` events for capture completed and capture declined. Payloads are untrusted and never reach a prompt (invariant 7). The sweep stays as the backstop. PayPal documents that mock events cannot use postback verification, so real sandbox events are captured as test fixtures.

Razorpay webhooks are out of scope.

### Concurrency (Phase 13, in scope)

A public demo creates real concurrency, so in-flight calls must count against budget. Scope follows `ROADMAP_PHASE2.md` Phase 13: a failing concurrent test first, then reservation in `deriveState`, the reconciler taking the mandate lock, and `pnpm reconcile`. This is also a strong demo moment: 20 simultaneous intents that cannot overspend.

### Hosted demo

- Hosted on Render, with its managed Postgres. Choice is partly because of the reported sponsor award. If it fails on us, any Node host works.
- Existing stack: the server-rendered `apps/receipt-ui` with its own CSS, extended with a small amount of client script for PayPal's checkout. No new front-end framework.
- **There is no public intent API.** Visitors pick from fixed scenarios on the server. The server holds the mandate signing key and issues a small mandate per visitor session. Free-text goals are not accepted on the hosted site.
- `evaluate()` step 17 sends a mandate's first purchase at any merchant to step-up, so a new session mandate can never go straight to `ALLOW`. The rule stays as it is, and the demo is one story built on it rather than separate scenarios:
  1. **First purchase:** step-up, because this merchant is new. The visitor approves, then completes a real sandbox checkout, and the ledger trace appears.
  2. **Second purchase:** the same merchant, below the threshold, `ALLOW` with no Praman approval. This is the moment the agent has earned trust.
  3. **Large purchase:** above the threshold, step-up again.
  4. **Injection:** a merchant listing from the static fixture corpus tries to steer the agent. The real model usually ignores it (0 of 21 defended runs were influenced), and the page shows that honestly. A second button then submits a fixed fixture intent directly, labelled "simulating a fooled model", and `evaluate()` refuses it with its reason code. The page also shows the recorded undefended run where the model really was fooled, labelled as recorded. Fixtures only (invariant 9).
  5. **Concurrency:** one real prior purchase on the simulated executor, then 20 simultaneous intents. These are server-generated cart variants with no model calls, labelled as test-harness intents.
- Razorpay is not on the hosted site. The video shows a real test-mode order through the existing CLI, and tests show the same policy cases on both rails.
- A global daily cap on model calls, per-session rate limits and sandbox credentials only. When the cap is hit, the site shows recorded runs, labelled as recorded.
- Langfuse links are not exposed publicly, because traces contain prompts and mandate-adjacent data. The video can show them.

### Evaluation and honesty

- Finish Phase 10: token spend in the report, the test that tracing is inert and survives an unreachable host, the decision record, the README section, and the build-log entry. Which of these are done gets confirmed against the code during planning.
- Add Wilson intervals and the Fisher test (Phase 11 item 5). They are cheap and they raise credibility: 2/21 against 0/21 has p about 0.49, and the README should say so.
- Add Layer 1 fixtures for USD mandates, `CURRENCY_MISMATCH`, and the same cases across both rails on the simulated executor.
- Regenerate `eval/report.md` so every README number matches it.

### The zero-diff check

CI runs a check that `packages/policy` has no diff between the commit that finishes the currency change and the commit that finishes PayPal. The claim is stated as two steps: adding a currency took one small policy change, and adding a rail took none. If PayPal forces a policy change, that goes in the README as a finding and the claim is reworded.

### Stretch, in order

1. A local MCP server exposing Praman as the only spending route, so Claude Desktop or Cursor can buy through it. Local stdio only, so no network identity problem. Strong for agentic commerce.
2. Phase 11 mutation testing of `evaluate.ts`, reported honestly.
3. Phase 12 database role separation.

## The sandbox spike (first task, throwaway, outside the repo)

Needs `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` in `.env`, created by the builder. Questions to answer:

1. Does the sandbox work from an Indian developer account?
2. Is INR accepted or rejected on order creation?
3. Same `PayPal-Request-Id`, same payload: what returns?
4. Same `PayPal-Request-Id`, different payload: what returns? If it silently returns the old order, Praman must compare amounts on return.
5. Two simultaneous requests with one key: what happens?
6. Does the key persist across create and capture, and what is its length limit?
7. Can an order be found after a lost response, and by what?
8. How do real sandbox webhooks arrive and verify? Requires a tunnel.
9. Can a vaulted payment method be charged in sandbox with no buyer present, and does it need extra approval from PayPal?
10. What happens to an order that is never approved, and can it be voided?

If question 1 fails, stop and bring it to the builder. A rejected INR is the expected result and does not stop anything. The results may change the reconciliation and idempotency sections, and are recorded in a decision record, as D-22 did for Razorpay.

## Schedule (IST)

| Date | Work |
|---|---|
| 4-5 Nov | Spike. Currency change, including `evaluate.ts`, mandate v2 and ledger reader. |
| 6 Nov | Rail interface. `paypal-exec`, reconciliation. |
| 7 Nov | Checkout flow, capture, webhooks. |
| 8 Nov | Phase 13 concurrency. Finish Phase 10. Statistics. |
| 9-10 Nov | Demo site and design pass. Deploy to Render. |
| 11 Nov | Feature freeze. Stretch only if everything is green. Eval regenerate, README, clean-clone test. |
| 12 Nov | Video and Devpost text. Submit by evening IST, well before the 01:30 cutoff. |

If time runs short, cut in this order: stretch items, statistics, the concurrency scenario on the site (keep the test), the vaulted purchase, the Razorpay segment of the video. Never cut: PayPal end to end, the currency check, the hosted demo, the video.

## Decided by the builder (2026-11-04)

Both are policy decisions, and both land before `packages/policy` is frozen, which is where the zero-diff window starts. The plan adds one reason code beyond this text, `ORDER_RELEASED`, because capturing a released order is not covered by any existing code and the caller must do something different.

1. **Budget during checkout and on abandonment.** A created order holds budget, since PayPal's checkout is a promise Praman has already authorised. An order unapproved after 10 minutes gets a `released` outcome that frees the budget but still counts toward velocity. After release the server refuses to capture that order, and no money can move without the server's capture call.
2. **Re-check at capture.** Yes, following D-24, because a mandate can be revoked or expire during checkout. A new small pure function, `evaluateCapture()`, goes in `packages/policy`, since re-running `evaluate()` would return `DUPLICATE_INTENT`. It checks revocation, the validity window and that the amount matches the ledger, using existing reason codes. D-17 gets a `Status:` pointer limiting it to Razorpay.

## Left to the builder

The engineer executing this decides package internals, test structure, exact file layout, the visual design within the anti-goals, and how to split commits, within `CLAUDE.md`.

## Agent's calls, for the builder to check

- Direct Orders API in `paypal-exec`, not the Agent Toolkit.
- No public intent API, and no free-text goals on the hosted site.
- Render as host.
- Phase 13 pulled forward. Phases 11 (most), 12, 14, 16 to 20 deferred.
- `CURRENCY_MISMATCH` as a new code rather than reusing `AMOUNT_INVALID`.
- The first-merchant step-up rule stays, and the demo is one story built on it.
- The injection scenario shows the model resisting, then a labelled fixture and a labelled recording.
- Concurrency uses test-harness intents with no model calls, to protect the daily cap.
- Razorpay appears in the video and tests, not on the hosted site.
- The mandate signing key lives on the hosted server, for per-session sandbox mandates only. It must be a separate demo key, never the local one.
