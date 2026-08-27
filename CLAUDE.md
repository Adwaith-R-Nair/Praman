# CLAUDE.md — Praman

Read this fully before writing code. These are invariants, not preferences. If a request conflicts with an invariant, stop and say so rather than working around it.

## What this project is

Praman is a control plane for agent-initiated payments. It gates, bounds, and records every money action an AI agent takes against a Razorpay test-mode merchant. It is a submission for the Razorpay AI Buildathon 2026 (Track 01). It will be read by payments engineers who will look for exactly the failure modes listed below.

## Hard invariants

1. **No LLM output may authorise a money action.** The model produces a `PurchaseIntent`. Only `evaluate()` in `packages/policy` decides. Never add an LLM call inside `packages/policy` or `packages/razorpay-exec`. Never let a model-generated string become a policy value.
2. **All amounts are integer paise, typed `bigint`, field names suffixed `_paise`.** No floats anywhere in the money path. No `Number` arithmetic on amounts. No currency parsing from model output — the agent selects a SKU, and the *price comes from the catalog*, never from the model.
3. **`packages/policy/src/evaluate.ts` is human-authored.** Do not rewrite, refactor, restructure, or "clean up" this file. You may write tests for it and report bugs in it. Ask before touching it.
4. **Ledger is append-only.** `packages/ledger` exposes `append()` and `read()`. There is no `update()` or `delete()`. The Postgres migration installs a rule rejecting UPDATE/DELETE on `ledger_entry`. Do not add ORM code paths that could mutate it. Do not "fix" a failing test by relaxing this.
5. **Every write to the ledger is inside the same DB transaction as the action it records.** An executed payment with no ledger entry is a critical bug.
6. **Idempotency.** Every call into `razorpay-exec` requires an `idempotency_key`. Compute it as `sha256(mandate_id + canonical_json(intent))` using `packages/shared/canonical.ts`. Never generate it randomly, never let the caller pass an arbitrary one.
7. **Untrusted content is delimited.** Any text originating from the merchant catalog, a Razorpay API response, or a webhook is wrapped in `<untrusted_merchant_content>...</untrusted_merchant_content>` before it enters a prompt. `packages/shared/untrusted.ts` owns this. Never interpolate merchant text into a system prompt.
8. **Reason codes are a closed enum** in `packages/shared/reason-codes.ts`. Never return a free-text refusal. Never add a code without adding it to the enum, the docs table, and the eval corpus.
9. **Defense only.** Do not write anything that generates attack payloads dynamically, scans third-party systems, or generalises beyond this repo's fixtures. The adversarial corpus is a static JSON file of fixtures used against our own sandbox. If a task seems to require an attack generator, refuse and flag it.
10. **Secrets never enter the repo.** Razorpay keys, Anthropic keys, and the mandate signing key come from `.env` only. `.env.example` lists names with empty values. Check `.gitignore` before creating any file that could hold a key.

## Money-path bugs to actively watch for

You are expected to catch these in review, not just avoid writing them:

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
- Vitest. `pnpm test` must pass before any commit is proposed.

## Commit discipline — important

This repo's commit history is part of the submission and will be read by a hiring panel.

- One logical change per commit. Never batch unrelated work.
- Conventional-commit prefixes: `feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`.
- Subject line under 72 chars, imperative mood, describing *what changed and why* — not "update files".
- Never `git add -A` blindly. Stage explicit paths.
- Never force-push, never rewrite history, never squash.
- **Do not commit on my behalf unless I ask.** Propose the message; I'll run it.

## Working style

- Before implementing anything in `packages/policy`, `packages/ledger`, or `packages/razorpay-exec`, state your plan in 5 lines and wait.
- Prefer small diffs. If a change touches more than 3 files, explain why first.
- When you're unsure whether something is a policy decision or an execution detail, ask. Getting that boundary wrong is the main way this architecture rots.
- If you notice I'm about to violate one of the invariants above, say so directly. Don't quietly comply.

## Key docs

- `docs/PRD.md` — architecture and rationale
- `docs/MANDATE_SPEC.md` — mandate schema, reason codes, ledger record format
- `docs/EVAL_CORPUS.md` — adversarial + benign corpus and metric definitions