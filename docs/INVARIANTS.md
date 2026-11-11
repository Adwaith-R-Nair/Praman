# Engineering Invariants

*Rules this codebase must not violate, regardless of who or what is writing the code.*

## What this project is

Praman is a control plane for agent-initiated payments. It gates, bounds, and records every money action an AI agent takes against Razorpay test-mode and PayPal sandbox merchants. It began as a submission for the Razorpay AI Buildathon 2026 (Track 01), and is now also a submission to the PayPal AI Hackathon. It will be read by payments engineers who will look for exactly the failure modes listed below.

## Hard invariants

1. **No LLM output may authorise a money action.** The model produces a `PurchaseIntent`. Only `evaluate()` in `packages/policy` decides. No LLM call exists inside `packages/policy`, `packages/ledger`, `packages/exec-core`, `packages/razorpay-exec`, `packages/paypal-exec` or `packages/channel3`, and `pnpm lint:boundary` (`scripts/check-import-boundary.ts`) fails CI if any of them imports a model, tracing or agent-toolkit package. No model-generated string becomes a policy value.
2. **All amounts are integer minor units, typed `bigint`, field names suffixed `_minor`, with the currency taken from the signed mandate.** Amended 2026-11-04. Currency is never inferred from region. Old `_paise` ledger rows and v1 mandates stay readable permanently (D-28). No floats anywhere in the money path. No `Number` arithmetic on amounts. No currency parsing from model output: the agent selects a SKU, and the *price comes from the catalog*, never from the model.
3. **`packages/policy/src/evaluate.ts` was hand-written up to the `v1.0-submission` tag.** Since 2026-11-04 agents may edit it (the builder's decision, D-27). Since 2026-11-07 agents change it without waiting for the builder (D-80): each change needs a failing test first, its own commit, and an independent agent review, and the builder is told what changed and why. Docs describe "hand-written" as history only, never as a present-tense claim. It stays a single readable pure function, and invariant 1 is unchanged.
4. **Ledger is append-only.** `packages/ledger` exposes `append()` and `read()`. There is no `update()` or `delete()`. The Postgres migration installs BEFORE UPDATE and BEFORE DELETE triggers on `ledger_entry` that raise an error. No ORM code path may mutate it. A failing test is never fixed by relaxing this.
5. **No external call is ever made without a durable, committed record naming what was about to happen.** A database transaction cannot be made atomic with an external API call: there is no protocol between Postgres and Razorpay that commits or fails both together (the dual-write problem; see D-22). Execution is therefore two phases, each internally transactional, not one transaction spanning the call: phase one derives, decides, and durably records the intent to call *before* calling; the call itself is outside any transaction, by necessity; phase two records the outcome. An executed payment with no trace of the attempt at all is a critical bug; a payment whose outcome is briefly unrecorded, with a durable pointer to reconcile it, is the accepted, named trade-off, not the same thing as no ledger entry.
6. **Idempotency.** Every call into an executor requires an `idempotency_key`. Computed as `sha256(mandate_id + canonical_json(intent))` using `packages/shared/src/canonical.ts`. Never generated randomly, never caller-supplied.
7. **Untrusted content is delimited.** Any text originating from the merchant catalog, a Razorpay API response, or a webhook is wrapped in `<untrusted_merchant_content>...</untrusted_merchant_content>` before it enters a prompt. `packages/shared/src/untrusted.ts` owns this. Merchant text is never interpolated into a system prompt.
8. **Reason codes are a closed enum** in `packages/shared/src/reason-codes.ts`. No free-text refusals. No code is added without also adding it to the enum, the docs table, and the eval corpus.
9. **Defense only.** Nothing in this repo generates attack payloads dynamically, scans third-party systems, or generalises beyond this repo's fixtures. The adversarial corpus is a static JSON file of fixtures used against this project's own sandbox.
10. **Secrets never enter the repo.** Razorpay keys, Anthropic keys, and the mandate signing key come from `.env` only. `.env.example` lists names with empty values. Any new file that could hold a key is checked against `.gitignore` before it's created.

## Money-path bugs to actively watch for

Caught in review, not just avoided in the first draft:

- double-charge on retry (missing or unstable idempotency key)
- amount taken from model output instead of the catalog
- policy checked before an amount mutation rather than after
- `STEP_UP` treated as `ALLOW` by a caller that only checks `!== 'DENY'`
- budget decremented outside the transaction that executes the payment
- reason code swallowed and replaced with a generic 500
- ledger append skipped on the error path

## Repo conventions

- TypeScript strict; `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` on. No `any`. No `as` casts in the money path.
- pnpm workspaces. Packages are `packages/*` (libraries) and `apps/*` (runnable).
- Errors are typed results (`Result<T, PramanError>`), not thrown exceptions, anywhere in the money path.
- Every exported function in `packages/policy` and `packages/ledger` has a unit test.
- Vitest. `pnpm test` must pass before any commit.

## Key docs

- `docs/PRD.md`: architecture and rationale
- `docs/MANDATE_SPEC.md`: mandate schema, reason codes, ledger record format
- `docs/EVAL_CORPUS.md`: adversarial + benign corpus and metric definitions
