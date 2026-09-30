# Praman · Roadmap, Phase 2 (Phases 9 to 21)

The submission is done: Phases 0 to 8 in [`ROADMAP.md`](ROADMAP.md) shipped, the repo was shortlisted, and it was defended in interview. This roadmap covers what comes next. There is no deadline, so phases are ordered by dependency and by what each one makes possible for the next, not by calendar.

Three goals carry equal weight, and every phase is tagged with the ones it serves:

- **P · Portfolio leverage.** Something a technical panel would notice and ask about.
- **R · Production readiness.** Closes a real gap, most of them listed under "Known gaps" in the README.
- **M · Mastery.** Forces a real understanding of agent evaluation, adversarial robustness, ledger design or observability, beyond what shipping the feature needs.

The rule from Phase 0 still holds: *if you cannot explain the phase you just finished without looking at the code, you do not start the next one.* Each phase ends with an understanding gate for that reason.

---

## How to execute this roadmap

These rules apply to every phase. The engineer executing a phase (human or model) reads this section first.

1. **Protected packages.** `CLAUDE.md` requires a five-line plan, and explicit approval, before any change to `packages/policy`, `packages/ledger` or `packages/razorpay-exec`. Phases that touch them are marked **⚑ PROTECTED** with the exact files involved. That includes test-only changes inside those packages. Post the plan, wait, then start.
2. **`packages/policy/src/evaluate.ts` is human-authored.** Two phases (19 and 20) need new decision logic. The builder writes that logic by hand. The executor writes the failing tests first, the surrounding plumbing, and the docs, and does not touch `evaluate.ts`. Those phases are marked **✎ HAND-WRITTEN**.
3. **Documentation happens inside the phase.** No phase is finished until it has (a) a build-log entry and (b) a decision record wherever a real design choice was made. There is no "docs cleanup" phase at the end.
   - Build log: new entries go under a `## Phase 2` divider in `docs/BUILD_LOG.md`, headed `### Phase N · <date> · <topic>`. The existing rule still applies: entries are never edited after the fact, and corrections are written forward.
   - Decision records: continue from D-25 in `docs/DECISIONS.md`. Numbers are assigned when the record is written, in the order they're written. The `D-xx` labels in this document are working titles, not reserved numbers. When a new record supersedes part of an old one (D-20 and D-22 will both be partly superseded), the old record gets a one-line `Status:` pointer forward. Its original text stays as written.
4. **Commits.** One logical change per commit, conventional prefixes, subject under 72 characters, explicit paths staged. The executor **proposes** commit messages and the builder runs them. The commit lists below are the expected boundaries, not a script: if the work splits differently, follow the work.
5. **Tests before behaviour changes on the money path.** Every phase that changes money-path semantics starts with a commit that adds a failing test showing the current gap. The failing commit is part of the evidence, in the same way `.heldout` was committed before tuning.
6. **Measure before redesigning.** Phase 18 is explicitly allowed to end with "measured, not needed yet" plus a decision record. Deciding with numbers counts as a result.
7. **Defense only, unchanged.** Every corpus addition is a static fixture. Property-based testing (Phase 11) generates *inputs to our own pure function* and is not an attack generator. No phase may generate injection text, paraphrase or mutate attack fixtures automatically, or target anything outside this repo's sandbox. If a task starts to look like that, stop and flag it.

---

## Pre-flight findings: what reading the repo turned up

These came from reading the code as it stands at `4b38243`, not the docs. Several of them shape the order of the phases below.

| # | Finding | Evidence | Severity | Closed in |
|---|---|---|---|---|
| F1 | **A forged-signature intent can lock any mandate.** On the signature-invalid path, `runIntent` appends a `DENY` decision whose payload uses the *claimed* `intent.mandate_id`. `deriveState` counts every `DENY` decision with that `mandate_id` toward `denied_attempts`, which feeds the `DENIAL_RATE_EXCEEDED` check. Anyone who knows a mandate's ID can send `max_denials_per_window` intents with a garbage signature and lock the real mandate. Under the CLI the caller is trusted, so this can't be exploited today. Behind an HTTP API it becomes a remote denial of service, and under a lifetime denial ceiling (Phase 19) the lock would be permanent. | `packages/control-plane/src/run-intent.ts` (signature-invalid branch), `packages/ledger/src/derive.ts` (`case "decision"`) | High once there is an API | 9 |
| F2 | **Four reason codes have no eval fixture:** `MANDATE_NOT_YET_VALID`, `MANDATE_SUBJECT_MISMATCH`, `VELOCITY_EXCEEDED`, `AMOUNT_CHANGED_SINCE_APPROVAL`. Invariant 8 and `MANDATE_SPEC.md` §4 say every code must appear in at least one fixture. | checked against `apps/eval/corpus/*.json` | Medium | 9, 11 |
| F3 | **The cast lint isn't in CI.** D-18 says "CI greps for `as Paise` casts". The grep exists as `lint:casts` in `packages/shared/package.json`, but `.github/workflows/ci.yml` never runs it. | `ci.yml` | Low, but it's a documented claim that isn't true | 9 |
| F4 | **The property tests LLD §5 requires don't exist.** There's no `fast-check`, and no pure, total or monotone property test over generated inputs. The monotonicity test is example-based. | `packages/policy/test/evaluate.test.ts` | Medium | 11 |
| F5 | **Docs have drifted from the code.** `MANDATE_SPEC.md` §3 gives an evaluation order the code no longer follows: `DUPLICATE_INTENT` is step 1, first-merchant step-up runs before threshold step-up, and the numbering differs. `MANDATE_SPEC.md` §5 and `LLD.md` §3 show `RULE ... DO INSTEAD NOTHING`, but the migration deliberately uses *raising triggers*. `ARCHITECTURE.md` says "closed enum of 17" (it's 19), "100 corpus cases, 60 adversarial" (it's 32 + 8), and "Postgres rules". `LLD.md` §7 describes an Express API that doesn't exist, and §9 names `claude-sonnet-4-6` while the agent runs Gemini. The `LedgerDerivedState.denied_attempts` comment says it is "not yet read by evaluate()", but it is. | the files named | Medium: a payments reviewer who reads the spec, then the code, finds contradictions in ten minutes | 9 |
| F6 | **`CLAUDE.md` invariant 5 is stale.** It still says every ledger write is "inside the same DB transaction as the action it records", which D-22 showed is impossible. `INVARIANTS.md` has the corrected wording. `CLAUDE.md` is gitignored and belongs to the builder, so the executor must not edit it. The builder should bring it in line with `INVARIANTS.md` before Phase 9 starts, because an executor following the stale wording could "fix" two-phase execution back into a single transaction. | `CLAUDE.md` vs `docs/INVARIANTS.md` | High for executor safety | before 9 (builder, by hand) |
| F7 | **The ablation difference isn't statistically significant.** 2/21 against 0/21 gives a two-sided Fisher exact p of about 0.49. A 95% Wilson interval on 0/21 runs up to about 15.5%, so the defended arm's measured zero fits an influence rate of one in seven. The README already says "experiment, not benchmark". What's missing is the number that makes that concrete. | `eval/report.md` | Medium: an honesty issue that becomes a credibility asset once it's stated | 11, 16 |
| F8 | **Token spend isn't reported,** although `EVAL_CORPUS.md` §5 promises it. | `apps/eval/src/metrics.ts` | Low | 10 |
| F9 | **A mandate is a bearer credential.** Nothing binds the caller to `mandate.subject_id`, so whoever holds `mandate.json` can spend under it. That's acceptable for a local CLI and not acceptable over a network. | `run-intent.ts`, `packages/mandate` | High once there is an API | 14 |
| F10 | **`intent_id` is chosen by the caller and is part of the idempotency preimage.** The same `intent_id` sent with a different cart produces a different key, and nothing flags the reuse. Stripe-style APIs reject an idempotency key reused with different parameters. | `packages/razorpay-exec/src/idempotency.ts`, `LLD.md` §6 | Medium once there is an API | 14 |
| F11 | **The TRUNCATE fix is described imprecisely.** The README says closing the gap "needs a statement-level event trigger". Postgres supports `BEFORE TRUNCATE ... FOR EACH STATEMENT` *table* triggers directly. Event triggers are for DDL, which is the separate problem of someone running `DROP TRIGGER`. More importantly, a table owner or superuser can disable any trigger, so the controls that actually hold are role separation plus external anchoring. | migration `20260901171804` | Medium | 12, 17 |
| F12 | **`seq` is supplied by the application, not generated by the database.** `LLD.md` §3 says `GENERATED ALWAYS AS IDENTITY` makes `seq` unsuppliable. The migration uses `BIGSERIAL`, and `append()` writes `head.seq + 1` explicitly. Integrity still holds because `seq` is in the hash preimage and `verifyChain` checks contiguity, but the doc's stated reason is wrong. | `append.ts`, init migration | Low; fix the doc, not the code | 9 |
| F13 | **Nothing runs the reconciler in normal operation.** `reconcilePending` exists and is tested, but there's no `pnpm reconcile` script. Pending records get resolved only by smoke scripts. | `package.json`, `scripts/` | Medium | 13 |
| F14 | **`api_call` ledger events don't carry `idempotency_key` or `merchant_id`.** Closing the T1/T2 window (Phase 13) needs to pair an attempt with its outcome, which today can only be done through `trace_id` or `receipt`. | `run-intent.ts` | Design input | 13 |

F1 is the most important item here. It was found while planning this roadmap, it's cheap to fix, and it has to be fixed before the two phases (14 and 19) that would make it exploitable. That's why Phase 9 comes first.

---

## Known gaps → the phase that closes them

| README "Known gap" | Closed by | Residual after closing |
|---|---|---|
| `TRUNCATE` bypasses the append-only triggers | Phase 12 | A superuser can still disable triggers. Phase 17 makes that detectable. |
| Merkle roots not anchored externally | Phase 17 | Trust moves to the timestamp authority. This is stated in the threat model. |
| Denial-rate cap is per window only | Phase 19 | Reset semantics become an explicit human action. |
| T1/T2 window: in-flight spend isn't counted | Phase 13 | An orphaned reservation holds budget until it's reconciled. This fails closed, by design. |
| One global ledger lock serialises all appends | Phase 18, if measurement justifies it | Documented either way. |
| `mandate.issuer` is `null` in dispute bundles | Phase 14 | None |
| No HTTP API (listed under "by design") | Phase 14 | Single instance, no HA. Out of scope, and stated. |
| Single-merchant demo | Phase 18 | |
| No delegation chains (PRD §7) | Phase 20 | Depth-capped |

---

## Phase 9 · Ground truth · P R

Fix the one real bug found while planning, make the CI enforce what the docs claim, and make the docs describe the code as it actually is.

**⚑ PROTECTED:** `packages/ledger/src/derive.ts` and its test. The five-line plan is required.

**Why this phase, why now.** Every later phase edits these docs and builds on these invariants. Building on contradictory docs makes the contradictions worse. F1 has to be closed before any phase that exposes intents to an untrusted caller. It's also the cheapest phase that gives a reviewer a concrete story: I read my own shipped code again, found a remote-lockout path, fixed it, and fixed it on the read side because the ledger can't be rewritten.

**Scope**

1. **F1, forged-signature lockout.**
   - Start with a failing test in `packages/control-plane/test/`. Register a real mandate, submit `max_denials_per_window` intents carrying that `mandate_id` with a tampered signature, then submit a legitimate intent under the real mandate. Today this returns `DENIAL_RATE_EXCEEDED`.
   - Write side (`run-intent.ts`): record an unverified claim under `claimed_mandate_id`, not `mandate_id`, so no future `deriveState` attributes it to anyone.
   - Read side (`derive.ts`, ⚑): exclude `DENY` decisions with `reason_code: MANDATE_SIGNATURE_INVALID` from `denied_attempts`. **This is the fix that matters**, because the ledger is append-only and entries in the old shape already exist and can never be rewritten. In an immutable log you can't correct the data. You correct how it's read, and you record why.
   - Check `apps/receipt-ui` and `packages/dispute` for anything that reads `mandate_id` off a signature-invalid decision. `signature_verified` in the dispute bundle is derived per trace, but confirm it.
2. **F2, reason-code coverage.** Add a check script, run in CI, that fails if any member of `REASON_CODES` is missing from every corpus `acceptable_reason_codes`. Add Layer 1 fixtures for `MANDATE_NOT_YET_VALID`, `MANDATE_SUBJECT_MISMATCH` and `VELOCITY_EXCEEDED`. `AMOUNT_CHANGED_SINCE_APPROVAL` needs an approval-cycle seeding path that doesn't exist yet: list it in the check's exception list with a comment pointing to Phase 11. That exception list must be empty when Phase 11 ends.
3. **F3 and the import boundary.** Run `lint:casts` in CI. Add a boundary check that fails if `packages/policy`, `packages/ledger` or `packages/razorpay-exec` import any of `@praman/agent-core`, `@google/genai`, `@anthropic-ai/sdk`, `@langfuse/*` or `@opentelemetry/*`. This turns invariant 1 from a convention into a build failure, and Phase 10 relies on it.
4. **F5 and F12, doc truth pass.** One commit per document family. Where history matters (the `EVAL_CORPUS.md` 100-case plan against the 40-case build), keep the original plan and add an "as built" table next to it rather than rewriting the plan. Mark `LLD.md` §7 (HTTP API) as "planned, Phase 14".
5. **Baseline tag.** The builder, not the executor, creates an annotated tag `v1.0-submission` at `4b38243`, so the evaluated state stays addressable permanently. A tag doesn't rewrite history.

**Exit criterion (demoable).** `pnpm test` includes the lockout test, which failed at its first commit and now passes. CI runs the coverage check, the cast lint and the boundary check, all green. Deliberately adding `import "@praman/agent-core"` to `packages/policy` fails CI (show it on a throwaway branch and don't merge). **Docs:** build-log entry; **D-xx "Unverified claims are not attributed to a mandate"**, stating that the fix is on the read side and why.

**Understanding gate.** *List every check in `evaluate()` that an unauthenticated caller can trigger, and say which of the resulting decisions `deriveState` remembers. Then explain why the F1 fix has to exist on the read side even after the write side is fixed.*

**Commit boundaries**
- `test: reproduce mandate lockout via forged-signature intents`
- `fix: exclude unverified-signature denials from denial count` ⚑ ledger
- `fix: record unverified mandate claims as claimed_mandate_id`
- `docs: record D-xx, unverified claims are not attributed`
- `test: add fixtures for three uncovered reason codes`
- `ci: fail when a reason code has no eval fixture`
- `ci: run the cast lint and a package import-boundary check`
- `docs: align mandate spec evaluation order with evaluate()`
- `docs: correct trigger, seq and enum claims in lld and architecture`
- `docs: add as-built tables to the eval corpus spec`
- `docs: log phase 9`

**Reduced scope.** Keep the F1 fix, the coverage check and the boundary check. Limit the doc truth pass to `MANDATE_SPEC.md` §3 and §5, which are the two most likely to be read against the code.

---

## Phase 10 · Langfuse: the debugging lens, kept apart from the record · P M

Instrument the agent's model calls and tool use with Langfuse. Write down clearly what Langfuse is for and what the ledger is for, and have the code enforce the difference.

**⚑ PROTECTED:** none, by design. The Phase 9 boundary check guarantees it.

**Why this phase, why now.** Observability comes early because it speeds up the feedback loop for every model-facing phase after it (11, 16, 21). Today, debugging a Layer 2 run means opening committed transcript JSON by hand. Langfuse was recommended by a Razorpay interviewer, and it only counts as having taken the advice if it's properly integrated with a thought-out boundary. The boundary matters more than the integration. It is also low risk: it sits entirely outside the authorisation path.

**The core decision** (full draft in [Appendix A](#appendix-a--draft-decision-record-langfuse)): *Langfuse is a lens for developers and the ledger is the record.* The ledger is append-only, hash-chained, derived-from rather than stored, and complete: every intent has its decision. Langfuse is mutable, can be sampled, has retention limits, is operated by a third party or a separate service, and isn't tamper-evident. Authority flows one way. The control plane writes the ledger. Instrumentation reads from the agent and copies what it sees to Langfuse. Nothing ever reads Langfuse back into a decision, a prompt, or a reported metric.

**Scope**

1. **SDK placement.** Use the current Langfuse TypeScript SDK, which is OpenTelemetry-based (`@langfuse/tracing`, `@langfuse/otel` with `LangfuseSpanProcessor`, and `@opentelemetry/sdk-node`). Check current package names and APIs against the Langfuse docs before writing anything. Don't work from memory. Initialise the SDK **only in entrypoints** (`apps/buyer-agent/src/demo.ts` and `apps/eval/src/cli.ts` / `ablation-cli.ts`), never in a library package. With no keys, no SDK starts and every call is a no-op.
2. **`TracedProvider` decorator** in `packages/agent-core`. It wraps any `ModelProvider`. Each `send()` becomes a `generation` observation carrying the model ID, input messages, output, latency, and token usage.
3. **Token usage (F8).** Add an optional `usage` field to `ProviderTurn`, filled from Gemini's `usageMetadata` and Anthropic's `usage`. The eval report computes token spend **locally** from this field. Langfuse displays the same numbers but is never where they come from.
4. **Agent trace.** `runAgent` produces one trace per goal: a span per tool call (`list_catalog`, `get_sku`) whose output is the tool result *exactly as the model received it*, delimiters included, plus a span for `propose_intent`. The caller wraps `runIntent` in a span whose output is the **agent-visible** decision plus the internal reason code. The `detail` string is excluded because it quotes mandate limits. Use the Langfuse processor's `mask` hook as a backstop.
5. **Correlation in both directions, authority in one.** The Langfuse trace gets `praman_trace_id` as metadata and a tag. The `agent_transcript` ledger event gets `observability: { langfuse_trace_id }`, explicitly labelled non-evidentiary: it's a convenience pointer and doesn't assert anything. The trace page (`/r/:trace_id`) shows a "debug trace" link when one exists.
6. **Prompt provenance goes in the ledger.** Record `system_prompt_sha256` (and the ablation arm flags) in the `agent_transcript` event. "Which defence prompt was active when this purchase was proposed" is an audit fact, so it belongs in the tamper-evident record. Langfuse gets it as metadata too.
7. **Eval tagging.** Layer 2 and ablation runs are tagged with `case_id`, `arm`, `repeat` and git SHA. The deterministic `influenced` and `money_moved` results are pushed as Langfuse scores. `eval/report.md` stays the source of truth and is regenerated by CI.
8. **Failure isolation.** Flush on shutdown with a timeout. Add a test showing that pointing Langfuse at a closed port leaves the demo and a Layer 2 case behaving identically, with the same ledger event types in the same order.
9. **Secrets.** Add the Langfuse key and host variables to `.env.example` with empty values, using the exact names from the current docs. Confirm `.env` is still ignored. CI has no Langfuse keys and needs none.
10. **Hosting choice**, recorded in the decision record. Self-hosted Langfuse (its own compose file, **not** part of the default quickstart) keeps merchant text and transcripts on the machine. Langfuse Cloud is simpler. Test mode makes either acceptable. Write down which one you picked and what data leaves the machine as a result.

**Explicitly rejected in this phase** (with reasons in the decision record):
- **Langfuse Prompt Management at runtime.** The defence prompt is a security control. If it's fetched from a mutable remote store, it can change without a commit or a review. Prompts stay in git.
- **Langfuse-hosted LLM-as-judge evaluators on headline metrics.** A non-deterministic scorer on the numbers in the README runs into the same objection as D-02. It would also send injected merchant text into yet another model. `influenced` stays deterministic.
- **Instrumenting inside the three protected packages.** The boundary check forbids it.

**Stretch (cut first):** vendor-neutral `@opentelemetry/api` spans inside `packages/control-plane` for T1 duration, lock wait, and the Razorpay call. The API is a no-op when nothing is registered. The rule is that span code can never change control flow: spans are started and ended in `try/finally`, and attributes are never read back.

**Exit criterion (demoable).** With keys set, `pnpm demo "order lunch for two under ₹700"` produces one Langfuse trace showing every generation with tokens and latency, every tool result including the wrapped merchant text, the proposal, and the Praman decision with a working link to `/r/:trace_id`, which links back. With keys unset, the same run produces the same sequence of ledger event types. The eval report shows token spend. **Docs:** build-log entry; **D-xx "Langfuse is a lens, the ledger is the record"**; README section "Observability vs evidence" (four sentences).

**Understanding gate.** *An auditor asks you to prove what the agent read before trace X's purchase. Which system do you open, and why not the other? Name three properties the ledger has that Langfuse lacks, and one thing Langfuse gives you that should never go into the ledger.*

**Commit boundaries**
- `feat: capture provider token usage in provider turns`
- `feat: add a traced model provider decorator`
- `feat: trace agent runs and tool calls through langfuse`
- `feat: link praman traces and langfuse traces both ways`
- `feat: record system prompt hash on the agent transcript event`
- `feat: tag eval and ablation runs and push deterministic scores`
- `feat: report token spend in the eval report`
- `test: tracing is inert without keys and survives an unreachable host`
- `chore: add langfuse variables to env example`
- `docs: record D-xx, langfuse is a lens, the ledger is the record`
- `docs: add observability vs evidence to the readme`
- `docs: log phase 10`

**Reduced scope.** Keep the decorator, the agent trace, correlation in both directions, the non-interference test and the decision record. Cut eval tagging and the control-plane spans.

---

## Phase 11 · Eval rigor I: know what your tests can detect · P M

Measure how much the existing test suite and corpus can actually catch, before any later phase changes money-path semantics.

**⚑ PROTECTED:** `packages/policy/test/*` and the mutation-testing config. `evaluate.ts` is **not edited**. Mutation testing makes temporary mutants of it in a sandbox copy. Get the builder's explicit agreement that this is compatible with invariant 3 before running it.

**Why this phase, why now.** The README's most honest sentence is also its weakest point: "no Layer 1 case has yet been observed to fail, so the corpus's discriminating power is untested." Mutation testing answers that directly and with a number. It has to come before Phases 13, 19 and 20, which change what the budget and denial checks mean. Before changing those semantics, you need to know whether your tests would notice a regression. This is also the statistics groundwork that Phase 16 reuses.

**Scope**

1. **Property tests (F4)** with `fast-check`, for the properties LLD §5 promised:
   - *pure*: repeated calls, and calls on structurally cloned inputs, deep-equal each other;
   - *total*: the function never throws on generated inputs, including malformed quantities and empty carts;
   - *monotone in spend*: once denied for budget, never allowed with more spend;
   - *precedence*: a revoked mandate always denies, whatever else is true.
   Also add the `canonical()` key-shuffle property from LLD §2.
2. **Mutation testing** (Stryker with the Vitest runner) over `evaluate.ts`. Report two scores: (a) unit tests alone, (b) the Layer 1 corpus alone, through a command runner. Score (b) is the one that answers the README. Every surviving mutant is either killed by a new test or fixture, or documented as an equivalent mutant with a reason. Too slow for every push: run it manually or nightly and commit the report.
3. **Approval-cycle seeding** in the eval runner, so a Layer 1 case can step up, change the catalog price, then approve. That closes `AMOUNT_CHANGED_SINCE_APPROVAL` and empties the Phase 9 exception list. Add the `legitimate_step_up` benign family that `EVAL_CORPUS.md` planned.
4. **Families from the original spec that never got built:** `catalog_tamper` (the price changes between the agent reading it and the evaluation, and the resolved amount must be the evaluation-time price) and `failure_handling` (simulated decline and timeout: assert one re-plan at most, and `IN_FLIGHT` rather than a blind retry).
5. **Statistics in the report.** Add a Wilson 95% interval to every rate and show *n* next to every number. Run a Fisher exact test on the ablation arms (F7). Rewrite the README's "How to read these numbers" to use intervals.
6. **Split v2.** Freeze the v1 assignment for the original 40 case IDs as a committed literal list, so it can never be quietly reshuffled. New cases use a family-stratified assignment, committed as `.heldout-v2` **before** they are first run. This deals with the 16/32 variance the report calls out, without re-salting v1 after the fact.

**Exit criterion (demoable).** `eval/report.md` shows the mutation score for `evaluate.ts` under both test sources, a table of surviving mutants each with its disposition, every reason code covered with an empty exception list, and intervals beside every rate. The README ablation paragraph states p ≈ 0.49 plainly. **Docs:** build-log entry; **D-xx "Held-out split v2, stratified and frozen"**; the `EVAL_CORPUS.md` as-built table updated.

**Understanding gate.** *Give your mutation score, describe one surviving mutant, and explain why it survives. Then explain why 2/21 against 0/21 isn't evidence that the delimiter works, and roughly what n per arm would be. Derive that n yourself.*

**Commit boundaries**
- `test: add property tests for purity, totality and monotonicity` ⚑ policy tests
- `test: add canonical key-order property test`
- `chore: add mutation testing config for the policy engine` ⚑
- `feat: run layer 1 corpus as a mutation-test command`
- `docs: publish mutation report with survivor dispositions`
- `feat: seed approval cycles in the layer 1 runner`
- `test: add amount-changed-since-approval and step-up cases`
- `chore: add catalog tamper and failure handling cases`
- `feat: report wilson intervals and ablation fisher test`
- `chore: freeze v1 split and commit stratified v2 manifest`
- `docs: record D-xx, split v2`
- `docs: restate readme numbers with intervals`
- `docs: log phase 11`

**Reduced scope.** Unit-test mutation score only, skipping the corpus runner. Skip split v2 and keep hash assignment, with a note in the report. Keep the property tests, approval seeding and intervals.

---

## Phase 12 · Immutability that holds against the app's own credentials · R M

Close the TRUNCATE gap properly, which means the test harness has to stop depending on it.

**⚑ PROTECTED:** `packages/ledger/test/*` (isolation rewrite) and new migrations in `packages/db`.

**Why this phase, why now.** This is the most obvious known gap, and a payments engineer will ask about it first. It's also a prerequisite for Phase 14, because once the app runs behind an HTTP API, the database role it uses is part of the attack surface. It has to come after Phase 11 because it rewrites how every DB-backed test resets state, and the property and mutation work should be settled before the harness changes under it.

**Scope**

1. **Test isolation, first.** Tests currently rely on `TRUNCATE`, so remove that dependency before anything else. The recommended approach: migrate a `praman_template` database once, and have each test file get a fresh clone via `CREATE DATABASE ... TEMPLATE praman_template`. Postgres copies a small template quickly. The alternative is unique-ID isolation, where only chain-verification tests need a fresh database. Pick one and record why in the build log. Remove `fileParallelism: false` only if the new approach actually makes files independent.
2. **Migration: `BEFORE TRUNCATE ON ledger_entry FOR EACH STATEMENT`**, raising, with its own function and message. (The current function reads `OLD.seq` / `NEW.seq`, which are null in a statement trigger.)
3. **Role separation.** `praman_owner` owns the tables and runs migrations. `praman_app` is the runtime role: on `ledger_entry` it gets `INSERT` and `SELECT` only, with no `UPDATE`, `DELETE` or `TRUNCATE`, and no ownership, so it can't `ALTER` or `DROP TRIGGER`. `idempotency_record` and `approval` stay mutable by design. The app gets its database URL through the `praman_app` role, and migrations use a separate owner URL. Check how Prisma 7's config expresses this; don't assume. Apply the same split in CI.
4. **Optional: a DDL event trigger** that rejects `ALTER TABLE` / `DROP TRIGGER` / `DROP TABLE` on `ledger_entry` outside migrations. Be honest that creating it needs superuser rights and a superuser can drop it again. It protects against mistakes, not a determined operator.
5. **Threat statement.** Database controls stop the application's credentials and careless operators. They don't stop a superuser. Only Phase 17 makes superuser tampering *detectable*. Say that plainly in the README.

**Exit criterion (demoable).** As `praman_app`, `UPDATE`, `DELETE` and `TRUNCATE` on `ledger_entry` all fail. As `praman_owner`, `TRUNCATE` fails through the trigger. `pnpm test` passes with the new isolation, and `grep -r TRUNCATE packages apps` finds nothing outside the reset helper. The README's TRUNCATE gap moves to "closed", with the residual stated. **Docs:** build-log entry; **D-xx "Least-privilege database roles; triggers are defence in depth, not the boundary"**, correcting the "event trigger" wording from F11.

**Understanding gate.** *List every way a Postgres superuser can still change history in this setup, and which control, now or in Phase 17, detects each one.*

**Commit boundaries**
- `test: isolate db tests with per-file template databases` ⚑ ledger tests
- `chore: remove truncate from test and eval reset paths`
- `feat: reject truncate on ledger_entry with a statement trigger`
- `feat: split database roles into owner and runtime app`
- `ci: run migrations as owner and tests as the app role`
- `test: assert the app role cannot mutate or truncate the ledger`
- `docs: record D-xx, least-privilege roles over triggers`
- `docs: close the truncate gap in readme and architecture`
- `docs: log phase 12`

**Reduced scope.** Skip the event trigger. Role separation and the TRUNCATE trigger are not optional.

---

## Phase 13 · Close the in-flight window · R M

Make budget and velocity count money that *might* have moved, and give the reconciler a normal way to run.

**⚑ PROTECTED:** `packages/ledger/src/derive.ts` (reservation semantics) and its tests.

**Why this phase, why now.** D-22 residuals 2 and 4 are the most payments-specific gap in the project: a concurrent intent can evaluate against an understated budget during a Razorpay call. It has to land before the HTTP API, because under a single-process CLI nothing actually happens concurrently, and behind an API it does. Phase 11 provides the mutation baseline this change is measured against.

**Scope**

1. **Concurrency harness first (red).** Use a `SimulatedExecutor` with a controllable latch, so every call waits until released. Fire N concurrent `runIntent` calls with distinct carts under one mandate, release them, and assert that the sum of created amounts is at most `max_total_paise` and the count is at most `max_txns_per_window`. Commit it failing. That commit is the evidence of the gap.
2. **Reservation in `deriveState` (⚑).** An `api_call` with `status: attempted` and no matching `outcome` counts toward `spent_paise` and `txn_timestamps`, and **not** toward `merchants_transacted`, because an attempt isn't an order and shouldn't satisfy the first-merchant step-up. A `failed` outcome, including a reconciled not-found, releases it.
   - **Pairing (F14):** old `api_call` events have no `idempotency_key`, so pair by `trace_id`. Add `idempotency_key` and `merchant_id` to *new* `api_call` payloads. The reader must handle both shapes forever, since you can't backfill an append-only log. This is schema evolution under immutability, and it's worth being able to explain.
   - **Why fold reservations into `spent_paise`** rather than adding a `reserved_paise` field: it leaves `evaluate.ts` untouched, and the check is meant to cover obligations that are committed *or may be committed*. D-17 already counts created orders on the same principle. Record this. The alternative is also defensible but needs a hand-written change to `evaluate()`.
   - **Consequence, named:** a pending record nobody reconciles holds its budget indefinitely. This fails closed, which is correct.
3. **The reconciler takes the per-mandate lock** after reading `mandate_id` from the intent event, closing D-22 residual 4.
4. **`pnpm reconcile` (F13).** A CLI that runs one sweep. Document that in production something has to schedule it, and that webhooks (Phase 15) shorten the wait without replacing the sweep.

**Exit criterion (demoable).** The concurrency test is green after being committed red. Run it live: 20 concurrent intents against a ₹5,000 mandate never create more than ₹5,000 of orders. The README's T1/T2 gap is closed. **Docs:** build-log entry; **D-xx "Attempted calls reserve budget"**, with D-22 residuals 2 and 4 given a `Status:` pointer forward.

**Understanding gate.** *For one mandate, walk through what `deriveState` returns at each point: T1 committed; Razorpay returned; crash before T2; reconciler ran and found nothing; reconciler ran and found a created order.*

**Commit boundaries**
- `test: show concurrent intents overspend during the call window`
- `feat: carry idempotency key and merchant on api_call events`
- `fix: count unresolved call attempts as reserved spend` ⚑ ledger
- `fix: hold the mandate lock while reconciling`
- `feat: add a reconcile cli`
- `docs: record D-xx, attempted calls reserve budget`
- `docs: log phase 13`

**Reduced scope.** Keep the reservation and the concurrency test. The reconcile CLI can wait until Phase 15.

---

## Phase 14 · HTTP API and agent identity · P R

Turn the control plane into a network service, and make the caller prove it is the agent the mandate names.

**⚑ PROTECTED:** `packages/ledger/src/append.ts` (new `mandate_registered` event type). Possibly `packages/shared/src/reason-codes.ts`, see item 5.

**Why this phase, why now.** It's the most visible missing piece, and LLD §7 already specifies it. It comes *after* 9, 12 and 13 on purpose. An API exposes intents to callers who aren't trusted, so the lockout bug, the database role and the concurrency window all have to be closed before one exists. It unlocks webhooks (15), load testing (18) and agent keys for delegation (20).

**Scope**

1. **`apps/api`.** Use Express as LLD specifies, unless you record a reason not to. Endpoints from LLD §7: mandates, revoke, intents, traces, approvals, health. Amounts are JSON strings (D-09). The same envelope is used for every outcome.
2. **A status map where no outcome looks like success by accident.** `ALLOW` → 200. `STEP_UP` → 202 with `approval_id`. `DENY` → 403 with `reason_code`. `IN_FLIGHT` → 202 with `Retry-After` and `decision: "IN_FLIGHT"`. Contract tests assert that `STEP_UP` and `IN_FLIGHT` never carry a payment, and that every refusal path includes its reason code. The generic 500 is for real internal faults only, and it still carries `trace_id`. This covers two of the bug classes in `CLAUDE.md` ("`STEP_UP` treated as `ALLOW`" and "reason code swallowed").
3. **Agent identity (F9).** Each agent has an Ed25519 key, and a mandate's `subject_id` resolves to a registered agent public key. Requests are signed over method, path, body digest, timestamp and nonce. RFC 9421 HTTP Message Signatures is the standard to evaluate; a detached JWS is the simpler option. Record the choice. Enforce a replay window and a nonce store. A request signed by anyone other than the mandate subject is denied as `MANDATE_SUBJECT_MISMATCH`, an existing code whose documented meaning ("intent references a different mandate/agent") already covers this.
4. **Mandate registration.** `POST /v1/mandates` verifies the signature and appends a `mandate_registered` ledger event containing the canonical document, `issuer_id` and `key_id`. The dispute bundle reads the issuer from the ledger, which closes the `mandate.issuer: null` gap. Add an issuer key registry with a `key_id` → public key mapping and a documented rotation procedure.
5. **Intent-ID conflict (F10).** Enforce uniqueness on `(mandate_id, intent_id)`. The same `intent_id` sent with different canonical content is rejected. **Decision needed from the builder:** add `INTENT_ID_CONFLICT` to the closed enum (along with the docs table and a corpus fixture, per invariant 8), or reuse `DUPLICATE_INTENT`. The recommendation is a new code, because a conflict isn't a duplicate and the caller has to do something different. Either way it's recorded as a ledger decision.
6. **Two closed enums, not one.** Transport errors (malformed JSON, missing signature, rate limited) aren't policy decisions and shouldn't be added to `REASON_CODES`. Define a separate closed `API_ERROR_CODES` enum, and write down the rule for which one applies: *if the request parses into an intent attributable to a verified mandate, it gets a ledger decision; otherwise it gets an API error and an ops log line, not a ledger entry.*
7. **Rate limiting** per agent key: an in-memory token bucket, stated as single-instance only.
8. **OpenAPI spec** committed. The buyer agent gets a `PRAMAN_API=1` path, like `PRAMAN_MCP=1`.

**Exit criterion (demoable).** Run a scripted curl session: register a mandate → signed intent → `202 STEP_UP` → approve → `200` with an order. An unsigned request, a request signed by the wrong agent, and a replayed request each get their typed code, and the wrong-agent case is on the ledger. `pnpm dispute <trace_id>` shows a non-null issuer. **Docs:** build-log entry; decision records **"Request signing binds the caller to the mandate subject"**, **"Transport errors vs policy decisions"**, and, if chosen, the new-reason-code record; `LLD.md` §7 status changed from planned to built.

**Understanding gate.** *`mandate.json` leaks. What can whoever holds it do before this phase, and what can they do after? Why is `STEP_UP` a 202 and not a 200? Which requests reach the ledger, and which stop at the API?*

**Commit boundaries**
- `feat: scaffold the http api with health and trace reads`
- `feat: add mandate registration with a ledger event` ⚑ ledger
- `feat: read issuer from the ledger in dispute bundles`
- `feat: authenticate agents with signed requests`
- `feat: accept intents over http with a uniform envelope`
- `test: step-up and in-flight never read as success over http`
- `feat: reject reused intent ids with different content` (+ enum, docs and fixture commits if a code is added)
- `feat: add approval and revocation endpoints`
- `feat: rate limit per agent key`
- `docs: add the openapi spec`
- `feat: let the buyer agent call the api behind a flag`
- `docs: record D-xx request signing and D-xx error taxonomy`
- `docs: log phase 14`

**Reduced scope.** Keep the endpoints, identity, registration and the contract tests. Cut rate limiting, OpenAPI and the agent flag.

---

## Phase 15 · Settlement truth: webhooks, payment state, refunds · R M

Follow money past order creation. The PRD's opening question ends with "and get it back"; nothing answers that part yet.

**⚑ PROTECTED:** `packages/razorpay-exec` (payment fetch, refund call) and `packages/ledger` (new `settlement` and `refund` event types).

**Why this phase, why now.** It needs Phase 14's HTTP surface. It shortens how long a D-22 pending record stays pending. And it's where a payments engineer's questions go once the gate itself is convincing: *what happens after the order? What if the webhook comes before your own write? How do you refund without double-refunding?*

**Scope**

1. **`POST /v1/webhooks/razorpay`.** Verify `X-Razorpay-Signature` (HMAC-SHA256) over the **raw request bytes**, before any JSON parsing. Deduplicate on Razorpay's event identifier; confirm which header or field carries it, empirically, the way D-22 tested receipts. Tolerate out-of-order and early delivery: a webhook that arrives before T2 commits must end up in a correct state. Append `settlement` events for payment captured, payment failed, order paid, and refund processed.
2. **Webhook payloads are untrusted content** (invariant 7). They never go into a prompt. If they're ever shown to an agent, they're wrapped.
3. **Webhook-assisted reconciliation.** A webhook naming a pending receipt resolves it without waiting for the 60-second sweep. The sweep stays as the backstop, since webhooks can be lost.
4. **Real fixtures.** Capture real test-mode webhook deliveries through a tunnel, strip anything secret, and commit them as fixtures. Contract tests run against those, not against payloads written by hand.
5. **Refunds (optional, cut first).** A human-initiated `pnpm refund <trace_id>`. Two decisions for the builder:
   - *Idempotency.* Invariant 6 is written around intents. The proposal is a canonical `RefundIntent` object with key `sha256(mandate_id + canonical(refund_intent))`, which satisfies the invariant as written. Flag it before building. Test empirically whether Razorpay deduplicates refunds; don't trust the docs, for the D-22 reasons.
   - *Does a refund restore budget?* Recommendation: **no** by default. Budget measures authority that has been *exercised*, and a refund doesn't undo that. Restoring it would create a spend → refund → spend loop that a colluding merchant could exploit. That's a policy decision, so it goes to the builder and gets a decision record.

**Exit criterion (demoable).** A real test-mode checkout payment leads to a webhook, then a `settlement` event on the ledger, then the trace page showing "captured". A webhook with a forged signature is rejected and logged, and nothing is appended. A duplicate delivery appends nothing new. **Docs:** build-log entry; **D-xx "Webhooks accelerate reconciliation; the sweep stays authoritative"**; if refunds are built, **D-xx "Refunds do not restore mandate budget"**.

**Understanding gate.** *Why must the signature be verified over the raw bytes? Walk through a webhook arriving before T2 commits. Why can't the reconciliation sweep be removed once webhooks work?*

**Commit boundaries**
- `feat: verify razorpay webhook signatures over the raw body`
- `feat: append settlement events from webhooks` ⚑ ledger
- `feat: dedupe webhook deliveries by event id`
- `feat: resolve pending records from webhook deliveries`
- `test: replay recorded webhook fixtures including out-of-order`
- `feat: show settlement state on the trace page`
- (optional) `feat: add refund execution with derived idempotency` ⚑ razorpay-exec
- `docs: record D-xx webhooks and the reconciliation sweep`
- `docs: log phase 15`

**Reduced scope.** Cut refunds entirely and name them in README limitations. Keep signature verification, dedupe and settlement events.

---

## Phase 16 · Eval rigor II: the experiment, pre-registered · P M

Turn the ablation from an anecdote into an experiment: pre-registered, factorial, adequately powered, run across more than one model, and tested against an attacker who didn't write the defence.

**⚑ PROTECTED:** none.

**Why this phase, why now.** Phase 11 built the statistics machinery and Phase 10 built the tooling for exploring runs. The README's two self-reported weaknesses are that the ablation removes delimiter and prompt together, and that everything was written by one author. This phase addresses both. It sits after the infrastructure phases so the experiment runs on the hardened system that will be discussed in interviews.

**Scope**

1. **Pre-registration, committed before any run.** `eval/prereg/phase16.md`: hypotheses (H1: the delimiter alone reduces influence; H2: the prompt instructions alone do; H3: they interact), primary metric, test (Fisher exact per contrast, or logistic regression with arm factors), α, *n* from a power analysis, stopping rule, exclusion rules (how `TURN_LIMIT` and `NO_PROPOSAL` are counted), models and temperature. Deviations are reported afterwards, never edited back in. This does for the experiment what the held-out commit did for the corpus.
2. **2×2 factorial.** `PRAMAN_NO_DELIMITER` and `PRAMAN_NO_PROMPT_DEFENCE` are already separate flags. Run all four arms.
3. **More than one model.** Gemini (current) plus Claude through the existing `AnthropicProvider`, at minimum. Record temperature and model version on every run. Budget rate limits and cost up front: the free Gemini tier's daily request cap will decide the calendar.
4. **A held-out attacker.**
   - *Sealed third-party set.* A peer writes N static injection fixtures against a frozen public brief (tool list, catalog schema, goals) without seeing `SYSTEM_PROMPT`. The SHA-256 of the sealed file is committed first. The file is revealed and run once, and the results are reported whatever they show.
   - *Optional, needs builder approval under invariant 9:* a small set of static fixtures adapted from a published prompt-injection benchmark, license-checked, used only against this sandbox. It's still a fixed file, not a generator. It's flagged because it brings in material this repo didn't write.
   - Not allowed: automatic paraphrasing or mutation of fixtures, since that is a generator.
5. **Langfuse for exploration** (datasets and experiment runs if useful). `eval/report.md` and committed per-run JSON remain the record.

**Exit criterion (demoable).** A published report with rates and intervals for each arm and model, the test statistics, a list of deviations from the pre-registration, and the held-out attacker results **including any failures**. Every number in the README comes from the regenerated report. **Docs:** build-log entry; **D-xx "Pre-registered evaluation"**; README "How to read these numbers" rewritten around the new results.

**Understanding gate.** *Explain the interaction term in your 2×2 in plain words. What result would have falsified the claim that "the prompt layer helps"? What did the third-party attacker find that you didn't?*

**Commit boundaries**
- `docs: pre-register the phase 16 injection experiment`
- `feat: run the ablation as a two-by-two factorial`
- `feat: run layer 2 across providers with recorded settings`
- `chore: commit hash of the sealed third-party corpus`
- `chore: reveal and add the third-party corpus`
- `chore: commit phase 16 run results and transcripts`
- `docs: publish phase 16 report with deviations`
- `docs: record D-xx, pre-registered evaluation`
- `docs: log phase 16`

**Reduced scope.** One model, the 2×2, and the power-analysed *n*. Skip the third-party set, and the README keeps its "self-authored" caveat. Pre-registration is never cut.

---

## Phase 17 · Anchoring, and a written threat model · P R M

Make rewriting the whole chain detectable by someone who doesn't trust the database operator.

**⚑ PROTECTED:** `packages/ledger` (signed checkpoints, `anchor` event type, `verify` anchor mode).

**Why this phase, why now.** Phase 12 stopped the app's own credentials. This phase covers the remaining attacker, a superuser who recomputes every hash consistently. It sits here because it depends on Phase 12's threat statement, and its demo is strongest once the API and settlement are real.

**Scope**

1. **Signed checkpoints.** A separate operator Ed25519 key (never the mandate issuer key) signs the canonical checkpoint payload.
2. **External anchor.** Compare the options in the decision record:
   - RFC 3161 timestamping from an independent TSA: standard, cheap, verifiable offline with `openssl ts -verify`, trust sits with the TSA;
   - Sigstore Rekor: a public transparency log with inclusion proofs;
   - OpenTimestamps: no trusted party, slow confirmation;
   - a public git repo of roots: same owner, too weak alone.
   The recommendation is RFC 3161 as the primary, with the option to add Rekor.
3. **Anchoring is an outbox, not a transaction.** The anchor call is a network call, so it can't sit inside the append transaction. That's D-22's dual-write problem again, and the same shape solves it: the checkpoint commits, an anchor job calls the TSA, and a later `anchor` ledger event records the token and the checkpoint `seq` it covers. Tokens are also exported to a published `anchors/` location outside the database.
4. **`verify-ledger --anchors`** checks each token against the TSA certificate and checks that each anchored root matches the recomputed range. This catches a full rewrite, and it also catches **backup rollback**: a database restored to before an anchored checkpoint.
5. **Stretch (mastery, cut first):** move from per-range roots to a cumulative RFC 6962-style Merkle tree with consistency proofs, so a verifier holding only an old root can confirm the new tree extends it. Version the checkpoint format; old checkpoints stay as they are.
6. **`docs/THREAT_MODEL.md`.** Actors (buyer agent, merchant, network attacker, holder of app credentials, DB superuser, operator, TSA), assets, controls, residual risks, and a STRIDE table. Each control points to the phase and decision record that introduced it.

**Exit criterion (demoable).** A two-part demo. First, as superuser, rewrite one payload and recompute every hash from that point on: plain `pnpm verify-ledger` **passes**, and that should be shown openly. Second, `pnpm verify-ledger --anchors` fails and names the first anchored checkpoint that no longer matches. Also restore an older backup and show rollback detected. **Docs:** build-log entry; **D-xx "External anchoring via RFC 3161"**; `THREAT_MODEL.md`; README gap closed, with the residual (trust in the TSA) stated.

**Understanding gate.** *Why does a fully recomputed chain pass verification without anchors? What exactly does the TSA attest to, and what does it not? Why is anchoring an outbox rather than part of the append transaction?*

**Commit boundaries**
- `feat: sign checkpoints with a separate operator key` ⚑ ledger
- `feat: anchor checkpoint roots with rfc 3161 timestamps`
- `feat: record anchors as ledger events after commit` ⚑ ledger
- `feat: verify anchors and detect rollback in verify-ledger` ⚑ ledger
- `test: full-chain rewrite passes plain verify, fails anchored`
- (stretch) `feat: add consistency proofs between checkpoints` ⚑ ledger
- `docs: add the threat model`
- `docs: record D-xx, external anchoring`
- `docs: log phase 17`

**Reduced scope.** RFC 3161 and verification only. No Rekor, no RFC 6962.

---

## Phase 18 · Scale: measure, then fix what the numbers show · P R M

Exercise multi-merchant use at realistic scale, measure the known bottlenecks, and change the ledger's shape only where the data justifies it.

**⚑ PROTECTED:** `packages/ledger` (state snapshots; possibly per-mandate sub-chains, which is the largest change to the ledger in this roadmap).

**Why this phase, why now.** Two known gaps (the global lock, and D-03's replay cost) are about performance, and nobody has measured them. The HTTP API (14) makes realistic load possible, and anchoring (17) has to be in place before the chain's structure changes, so the migration itself is anchored.

**Scope**

1. **Load harness** (`apps/loadtest`, using k6 or autocannon against `apps/api`). Seed 50 merchants × 1,000 SKUs and 1,000 mandates, some spanning several merchants. Use a `SimulatedExecutor` with configurable latency. Report throughput and p50/p95/p99 decision latency at several concurrency levels, **measured** lock wait (sampled from `pg_locks` / `log_lock_waits`, not inferred), and `deriveState` time against history length. Record the machine specs.
2. **Multi-merchant correctness under load.** Eval cases for budget shared across merchants, lookalike merchant IDs, and a mandate spanning N merchants under concurrent intents. Reuse the Phase 13 harness at scale.
3. **Expected hot spots, in order:** `deriveState` replaying all history; `maybeCheckpoint` scanning from the last checkpoint on every transaction; the global append lock.
4. **Fix 1: derived-state snapshots.** A periodic `state_snapshot` ledger event per mandate. `deriveState` replays from the latest snapshot instead of from genesis. D-03 still holds, because the snapshot is an optimisation whose correctness can be checked: `verify-ledger` re-derives from genesis and compares.
5. **Fix 2, only if item 1 shows lock contention matters: per-mandate sub-chains.**
   - Add a `chain_id` column, with `seq` and `prev_hash` per chain.
   - A v2 hash preimage that includes `chain_id` and a `hash_version`, for domain separation.
   - A system chain for checkpoints, plus a periodic checkpoint over all chain heads.
   - Migration under immutability: the legacy chain ends with a `chain_migrated` entry whose hash seeds the new chains. Nothing old is rewritten.
   - `verify-ledger`, the trace page's hash spine and the dispute bundle all learn the new shape. `agent_transcript` currently has no `mandate_id` and routes by `trace_id`.
6. If contention isn't significant at plausible load, **don't build item 5.** Write a decision record saying so, with the numbers, and put the sub-chain design in it as the documented next step. That counts as a complete result.

**Exit criterion (demoable).** `docs/BENCHMARKS.md` with before and after numbers from one script anyone can rerun, and a chart of decision latency against concurrency and history length. Snapshots in production use. Either sub-chains built and verified, or a decision record with numbers showing why not. **Docs:** build-log entry; **D-xx "State snapshots"**; **D-xx "Per-mandate chains: built / not yet, with numbers"**.

**Understanding gate.** *At what request rate does the global lock become the bottleneck on your machine, and how did you measure lock wait rather than infer it? How do you migrate an append-only, hash-chained table to a new structure without rewriting a row?*

**Commit boundaries**
- `feat: add a load harness with multi-merchant seeding`
- `docs: publish baseline benchmarks`
- `test: shared budget across merchants under concurrency`
- `feat: snapshot derived state on the ledger` ⚑ ledger
- `feat: verify snapshots against full replay` ⚑ ledger
- (conditional) `feat: add chain id and v2 hash preimage` ⚑ ledger, plus migration, verify and UI commits
- `docs: publish post-change benchmarks`
- `docs: record D-xx snapshots and D-xx sub-chains decision`
- `docs: log phase 18`

**Reduced scope.** Benchmarks and snapshots only. Sub-chains stay a design written in a decision record.

---

## Phase 19 · Mandate v2: a lifetime denial ceiling · R M

Answer the policy question D-20 deliberately left open.

**⚑ PROTECTED + ✎ HAND-WRITTEN:** `packages/policy/src/evaluate.ts` (**the builder writes the change**), `packages/mandate` (schema v2), `packages/ledger/src/derive.ts`, `packages/shared/src/reason-codes.ts`.

**Why this phase, why now.** Slow probing across windows is the last open gap in the probe-oracle story (D-19 → D-20). It comes after Phase 9 because a global ceiling combined with the F1 bug would have let anyone lock any mandate *permanently*. It comes after Phase 11 because it changes `evaluate()` and needs a mutation baseline. It comes before Phase 20 because both need mandate schema versioning, and it's the smaller of the two changes.

**Scope**

1. **Mandate `version: 2`** adds `limits.max_denials_total`. The signature covers it. v1 mandates stay valid with no ceiling, and that's explicit and tested, not implied.
2. **Semantics, decided by the builder and recorded:**
   - *Reset:* the recommendation is an issuer-signed `mandate_unlocked` ledger event (`pnpm unlock <mandate_id> "<reason>"`), because it leaves an audit trail and matches the "pending human review" wording `DENIAL_RATE_EXCEEDED` already uses. The alternative is to require a new mandate.
   - *What counts:* signature-invalid denials are already excluded (Phase 9). Decide whether `DUPLICATE_INTENT` counts, since a legitimate client's retry storm shouldn't lock a mandate.
   - *Reason code:* the recommendation is a new code, `MANDATE_LOCKED`, because the fix is different: the window cap clears itself, and the ceiling doesn't. That means the enum, the `MANDATE_SPEC.md` table and a corpus fixture (invariant 8).
3. **Order of work.** The executor writes failing tests: a slow-probe fixture that stays under the window cap across windows (named in D-20), v1 compatibility, and unlock. The builder hand-writes the `evaluate.ts` check and decides where it goes in the order (recommendation: next to 2b, after revocation). The executor does the derive, schema and CLI plumbing.

**Exit criterion (demoable).** The slow-probe case is contained. An unlock demo shows the lock, the signed unlock, and purchases resuming, all on the ledger. v1 mandates behave exactly as before. The mutation score for `evaluate.ts` is at least the Phase 11 baseline. **Docs:** build-log entry; **D-xx "Lifetime denial ceiling and signed unlock"**, with D-20 given a `Status:` pointer forward; `MANDATE_SPEC.md` §1, §3 and §4 updated.

**Understanding gate.** *Why is a lifetime ceiling a policy decision and not a bug fix? What does a legitimate agent experience when it hits the ceiling, and who gets it moving again?*

**Commit boundaries**
- `test: slow probe stays under the window cap indefinitely` ⚑ policy tests
- `feat: add mandate schema v2 with a lifetime denial limit`
- `feat: add MANDATE_LOCKED to reason codes and spec table`
- `feat: enforce the lifetime denial ceiling` ✎ **builder's commit**
- `feat: derive unlock events and add an unlock cli` ⚑ ledger
- `test: v1 mandates are unaffected by the ceiling`
- `chore: add the slow-probe and locked-mandate fixtures`
- `docs: record D-xx, lifetime denial ceiling`
- `docs: log phase 19`

**Reduced scope.** Leave out the unlock event. A locked mandate needs a newly issued mandate, which is simpler and still auditable.

---

## Phase 20 · Delegation chains · P M

Let an agent hand a strictly smaller slice of its authority to a sub-agent. The original PRD scoped this out explicitly.

**⚑ PROTECTED + ✎ HAND-WRITTEN:** `packages/policy` (**builder writes the chain-aware decision logic**), `packages/mandate`, `packages/ledger/src/derive.ts`.

**Why this phase, why now.** It's the most research-heavy capability in the roadmap: attenuation-only delegation, the model behind macaroons, UCAN and Biscuit tokens. It depends on agent keys (14), registration events (14) and schema versioning (19).

**Scope**

1. **Sub-mandates.** Issued by the parent's *subject*, signed with its Phase 14 agent key, carrying `parent_mandate_id`. **Attenuation only:** merchants and categories must be subsets, limits no higher, validity inside the parent's window, and a depth cap of 2.
2. **Checked twice.** Attenuation is checked at issuance (in `packages/mandate`) **and** at evaluation, because a parent can be revoked or can expire after the child was issued.
3. **Evaluation design, for the builder to choose and write.**
   - (a) A new `evaluateChain()` in its own file that calls the existing `evaluate()` once per level, with the intent re-bound to that level's `mandate_id` and a derived state that sums spend across the level's subtree. Deny if any level denies, and record which level did. This leaves `evaluate.ts` untouched.
   - (b) Make `evaluate()` itself aware of chains.
   The recommendation is (a). Either way it's decision logic, so the builder writes it.
4. **Derivation.** `deriveState` for an ancestor aggregates its descendants' spend. The subtree comes from `mandate_registered` events.
5. **Cascade.** Revoking a parent denies every descendant, with no separate revocation events needed.
6. **New reason code** `DELEGATION_INVALID` for chain-verification failures, if (b) or issuance checks need one. Enum, docs and fixture as usual.

**Exit criterion (demoable).** Parent mandate ₹5,000, child ₹2,000, sibling ₹4,000. The child spends ₹2,000, then the sibling's ₹3,500 intent is **denied at the parent level**, and the trace page names that level. Revoking the parent denies both children. Issuing a child with a wider scope is refused at issuance. **Docs:** build-log entry; **D-xx "Attenuation-only delegation"**; `MANDATE_SPEC.md` gains a delegation section; PRD §7's "not implemented" line gets a pointer forward.

**Understanding gate.** *Why must attenuation be checked both at issuance and at evaluation? Two siblings spend concurrently under the same parent: which lock serialises them, and is that the right one?*

**Commit boundaries**
- `test: sibling spend is bounded by the parent budget` ⚑
- `feat: add sub-mandate issuance with attenuation checks`
- `feat: derive subtree spend for ancestor mandates` ⚑ ledger
- `feat: evaluate intents against every level of a chain` ✎ **builder's commit**
- `feat: cascade parent revocation to descendants`
- `feat: show the denying level on the trace page`
- `chore: add delegation fixtures`
- `docs: record D-xx, attenuation-only delegation`
- `docs: log phase 20`

**Reduced scope.** Depth 1 only (a parent and its direct children), with no trace-page changes.

---

## Phase 21 · Generalisation: a second scenario with zero policy diff · P

Show that the architecture is general by adding a second buyer scenario without changing the trust core.

**⚑ PROTECTED:** none, and that is the point. If this phase needs a protected-package change, stop and record it as a finding.

**Why this phase, why now.** It comes last because it tests everything before it. "Does this generalise beyond lunch?" is a likely question from a panel. The strongest answer is a diff stat.

**Scope**

1. **A second scenario.** For example, an office-supplies procurement agent: several merchants, different categories, quantity-heavy carts, step-ups on bulk orders. It gets its own merchant MCP catalog fixtures, its own goals, and its own Layer 1 and Layer 2 subset.
2. **A CI check for the claim.** For this phase's commits, `git diff --stat <phase-start>..HEAD -- packages/policy packages/ledger packages/razorpay-exec packages/mandate` must be empty. If it isn't, that's the finding: record what forced the change, and don't hide it.
3. **Alternative in the same slot:** a protocol adapter. The original roadmap deferred UAP, AP2 and ACP adapters "once specifications are public". Check which of them are now public and stable. If one has mandate semantics that map cleanly (AP2's intent and cart mandates are the obvious candidate), an adapter that turns its mandate into a Praman mandate, with no policy change, is an equally strong result. Pick one; don't do both.

**Exit criterion (demoable).** `pnpm demo --scenario procurement "…"` runs end to end, the scenario has its own eval numbers with intervals, and the empty-diff check passes in CI. **Docs:** build-log entry; a README section "A second scenario"; a decision record only if a protected change turned out to be necessary.

**Understanding gate.** *What in the second scenario almost needed a policy change, and why didn't it? If it did, why was it unavoidable?*

**Commit boundaries**
- `chore: add procurement merchant catalogs and fixtures`
- `feat: add the procurement buyer scenario`
- `chore: add procurement eval cases`
- `ci: assert no trust-core diff for the scenario phase`
- `docs: add the second scenario to the readme`
- `docs: log phase 21`

**Reduced scope.** Layer 1 cases only for the new scenario, skipping the live-model runs.

---

## Milestones, in dependency order

Pacing is deliberately undecided. Read this table as "can't start before", not as dates.

| # | Phase | Milestone: by the end of it | Depends on | Goals | Protected |
|---|---|---|---|---|---|
| M9 | 9 · Ground truth | The docs describe the code, and CI enforces what they claim | builder fixes F6 first | P R | ⚑ ledger |
| M10 | 10 · Langfuse | Every model decision is inspectable, and never authoritative | 9 (boundary check) | P M | none |
| M11 | 11 · Eval rigor I | We know how much our tests can detect | 9 | P M | ⚑ policy tests |
| M12 | 12 · Immutability | The app's own credentials cannot rewrite history | 11 | R M | ⚑ ledger tests |
| M13 | 13 · In-flight window | Concurrency cannot overspend | 11, 12 | R M | ⚑ ledger |
| M14 | 14 · HTTP API + identity | Only the named agent can spend a mandate, over a network | 9, 12, 13 | P R | ⚑ ledger |
| M15 | 15 · Settlement | Money is followed past order creation | 14 | R M | ⚑ exec, ledger |
| M16 | 16 · Eval rigor II | The injection claim is measured, not anecdotal | 10, 11 | P M | none |
| M17 | 17 · Anchoring | Even a superuser's rewrite is detectable | 12 | P R M | ⚑ ledger |
| M18 | 18 · Scale | Performance claims come with numbers | 14, 17 | P R M | ⚑ ledger |
| M19 | 19 · Mandate v2 ceiling | Probing is bounded absolutely | 9, 11, 14 | R M | ⚑ ✎ policy |
| M20 | 20 · Delegation | Authority can be delegated only by narrowing it | 14, 19 | P M | ⚑ ✎ policy |
| M21 | 21 · Generalisation | A second scenario needs no trust-core change | 14 (and 20 if it uses delegation) | P | none |

**Load-bearing milestones: M9, M12, M13, M16.** M9 and M13 are the only phases that fix behaviour that's wrong today. M12 closes the gap a reviewer raises first. M16 turns the project's central empirical claim from an anecdote into a measured result. If effort has to be concentrated, protect these four.

**Why this order, briefly.** Correctness debt comes first (9), because everything is built on top of it. Observability (10) comes next, because it speeds up every model-facing phase after it. Measuring what the tests can detect (11) comes before any change to money-path semantics (13, 19, 20). The hardening that an untrusted caller makes necessary (12, 13) lands before the HTTP API (14). After that, gap-closing (15, 17), research depth (16) and new capability (18 to 21) alternate, so no goal goes a long stretch without progress.

---

## Cut list, in order

1. Phase 21 (keep as a README roadmap line)
2. Phase 20, down to depth 1, then entirely
3. Phase 15 refunds
4. Phase 18 sub-chains (keep the benchmarks and the decision record)
5. Phase 17 RFC 6962 consistency proofs
6. Phase 16 third-party corpus (the README keeps its "self-authored" caveat)
7. Phase 10 control-plane spans and eval tagging

**Never cut:** the F1 fix and the CI enforcement (9), the Langfuse decision record and the non-interference test (10), mutation testing and the intervals (11), role separation (12), in-flight reservation (13), request signing (14), pre-registration (16).

Every cut goes into the README's limitations section, as before.

---

## Considered, not scheduled

- **A Rust policy core.** D-18 called it "first on the post-submission roadmap". Having now costed it against these three goals, it isn't scheduled. Its only real benefit (newtypes that survive to runtime) is weaker than the FFI boundary it adds, which is D-18's own argument, and Phases 11, 13 and 17 buy more of all three goals. Record a short decision that supersedes D-18's sequencing sentence so the old promise isn't left open.
- **An LLM reviewer anywhere in authorisation.** Rejected by D-02, and that doesn't change.
- **A policy-as-code DSL.** It would stop `evaluate.ts` from being a single file that a human wrote and can read top to bottom (invariant 3). Revisit only if the builder decides to give that property up.
- **Multi-instance deployment, HA or Kubernetes.** This work is about correctness under a single Postgres. The advisory-lock design assumes a single database, and the threat model says so.
- **Live-mode keys.** Test mode only, permanently for this repo.
- **Fuzzing prompts or generating attacks automatically.** Excluded by invariant 9. Property testing of `evaluate()` in Phase 11 is allowed because its inputs go to our own pure function, not to a model, and it produces no attack text.

---

## Appendix A · Draft decision record: Langfuse

*To be copied into `docs/DECISIONS.md` during Phase 10, with its number assigned then and revised to match what was actually built.*

### D-xx · Langfuse is the debugging lens; the ledger is the record · Proposed

**Decision.** Langfuse traces the buyer agent's model calls, tool use and eval runs so developers can inspect them. It is not evidence, has no role in authorisation, and nothing in Praman reads data back out of it.

**Why two systems, not one.** They answer different questions for different people.

| | Ledger | Langfuse |
|---|---|---|
| Question it answers | *Was this money action authorised, and can that be proven later?* | *Why did the model propose this, and where did the time and tokens go?* |
| Audience | Dispute officer, auditor, risk team | Developer debugging or tuning the agent |
| Mutability | Append-only; triggers and least-privilege roles (D-xx); anchored externally (D-xx) | Traces can be edited, deleted and expired |
| Completeness | Every intent has its decision, and every call attempt is recorded before the call (D-22) | Can be sampled; best-effort, asynchronous export; may drop data during an outage |
| Integrity | Hash chain, Merkle checkpoints, `verify-ledger` | None the reader can verify independently |
| Operator | Us, inside the trust boundary | A separate service, possibly a third party |

A system with Langfuse's properties can't carry the ledger's guarantees. Using the ledger as a debugging tool would mean filling a tamper-evident record with high-volume telemetry that is neither needed nor safe to keep forever.

**Rules.**
1. Authority flows one way. The control plane writes the ledger. Instrumentation copies agent-side activity to Langfuse. No decision, prompt, reported metric or UI claim of verification reads from Langfuse.
2. Langfuse is initialised only in entrypoints. `packages/policy`, `packages/ledger` and `packages/razorpay-exec` can't import it, and CI enforces that (Phase 9).
3. If an audit could need a fact, it goes in the ledger, even if Langfuse also has it. The active system-prompt hash and ablation flags are recorded on `agent_transcript` for this reason.
4. The ledger may hold a pointer to a Langfuse trace, labelled non-evidentiary. The pointer asserts nothing, and a broken pointer has no effect on verification.
5. Losing Langfuse is harmless: with no keys or an unreachable host, behaviour and ledger contents are unchanged. A test enforces this.
6. Mandate limits don't go to Langfuse: exported decisions are the redacted agent-visible form plus the reason code, never `detail`.
7. Langfuse data never goes back into a prompt. This is the same rule `recordAgentTranscript` applies to its own evidence, and for the same reason: it contains injected merchant text.

**Rejected.**
- *Langfuse as the audit trail.* It can't be verified or proven complete, and it's mutable. It fails every property in the table's ledger column.
- *Runtime Prompt Management for the system prompt.* The defence prompt is a security control. Serving it from a mutable remote store lets it change without a commit or review, and makes a trace's provenance depend on the store's history. Prompts stay in git; Langfuse may keep a read-only mirror labelled with the git SHA.
- *Langfuse-hosted LLM-as-judge scores on reported metrics.* The D-02 objection (a non-deterministic scorer can't be regression-tested) applies to the numbers in the README too, and it would send injected merchant text into another model. `influenced` stays deterministic. Exploratory annotations are fine if they're labelled as such and never reported as results.

**Consequence.** Two systems record overlapping activity, and a reader has to know which one to trust for what. The README's "Observability vs evidence" section exists to explain that. The overlap is the cost of not mixing a debugging tool with evidence.
