# Engineering Invariants

*Rules this codebase must not violate, regardless of who or what is writing the code.*

## What this project is

Praman is a control plane for agent-initiated payments. It gates, bounds, and records every money action an AI agent takes against a Razorpay test-mode merchant. It is a submission for the Razorpay AI Buildathon 2026 (Track 01). It will be read by payments engineers who will look for exactly the failure modes listed below.

## Hard invariants

1. **No LLM output may authorise a money action.** The model produces a `PurchaseIntent`. Only `evaluate()` in `packages/policy` decides. No LLM call exists inside `packages/policy` or `packages/razorpay-exec`. No model-generated string becomes a policy value.
2. **All amounts are integer paise, typed `bigint`, field names suffixed `_paise`.** No floats anywhere in the money path. No `Number` arithmetic on amounts. No currency parsing from model output — the agent selects a SKU, and the *price comes from the catalog*, never from the model.
3. **`packages/policy/src/evaluate.ts` is human-authored.** Tests are written against it and bugs are reported in it; it is not rewritten, refactored, restructured, or "cleaned up" without the original author's explicit sign-off.
4. **Ledger is append-only.** `packages/ledger` exposes `append()` and `read()`. There is no `update()` or `delete()`. The Postgres migration installs a rule rejecting UPDATE/DELETE on `ledger_entry`. No ORM code path may mutate it. A failing test is never fixed by relaxing this.
5. **Every write to the ledger is inside the same DB transaction as the action it records.** An executed payment with no ledger entry is a critical bug.
6. **Idempotency.** Every call into `razorpay-exec` requires an `idempotency_key`. Computed as `sha256(mandate_id + canonical_json(intent))` using `packages/shared/canonical.ts`. Never generated randomly, never caller-supplied.
7. **Untrusted content is delimited.** Any text originating from the merchant catalog, a Razorpay API response, or a webhook is wrapped in `<untrusted_merchant_content>...</untrusted_merchant_content>` before it enters a prompt. `packages/shared/untrusted.ts` owns this. Merchant text is never interpolated into a system prompt.
8. **Reason codes are a closed enum** in `packages/shared/reason-codes.ts`. No free-text refusals. No code is added without also adding it to the enum, the docs table, and the eval corpus.
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

- `docs/PRD.md` — architecture and rationale
- `docs/MANDATE_SPEC.md` — mandate schema, reason codes, ledger record format
- `docs/EVAL_CORPUS.md` — adversarial + benign corpus and metric definitions
