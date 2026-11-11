# Praman: Architecture

*This is the reviewer-facing document. Five minutes end to end. `HLD.md` and `LLD.md` go deeper; `DECISIONS.md` records why.*

---

## What this is

A control plane that sits between an AI buyer agent and a merchant on the PayPal sandbox or Razorpay test mode, making every amount the agent moves **bounded, explainable, and replayable**. The currency, INR or USD, comes from the signed mandate.

> The model proposes. The policy engine disposes. The ledger remembers.

## Why it exists

NPCI is building the Unified Agent Protocol so AI agents can transact over UPI. Razorpay and NPCI piloted agentic UPI payments on Claude in February 2026, using consent-based per-merchant spending limits. The rails are arriving.

Praman started on those rails and now runs on PayPal as well; the problem is the same on both.

What isn't arriving is the layer that answers the question every risk team asks: **when an agent spends money it shouldn't have, how do you find out, prove it, and get it back?**

Today's agentic checkout reads attacker-controllable text (a merchant's product description) and then calls a payment API. That is prompt injection with a bank account attached, and there is no record of *why* the model decided anything.

## The one idea

Most approaches try to make the model safe. Praman makes the model **irrelevant to authorisation**.

The `PurchaseIntent` the agent emits contains a SKU and a quantity, and nothing else. No price. No merchant override. No scope.

```jsonc
{ "mandate_id": "mnd_…", "merchant_id": "MERCH_001",
  "line_items": [{ "sku": "SKU_MEALS_042", "qty": 2 }] }
```

The amount is resolved server-side from the catalog, *after* the SKU and its category have been validated against a signed, human-issued mandate. A product page that says "this item costs ₹1" cannot influence the charge, because the model never handles the number.

Injection can make the model *want* the wrong thing. It cannot make the system *charge* the wrong thing.

## The three primitives

**1. Mandate:** a human-signed (Ed25519) grant of bounded authority: merchant allowlist, category allowlist, per-transaction cap, cumulative cap, velocity limit, denial-rate cap, validity window, human-approval threshold. Modelled on the delegation-plus-limit pattern from UPI Circle and the Razorpay–NPCI pilot. Protocol-agnostic by design, since UAP is unpublished.

**2. Policy engine:** a pure, total, deterministic function of one input object (`intent`, `mandate`, `ledger_state`, `catalog`, `now`, `idempotency_key`). No I/O, no clock, no randomness, **no LLM**. Returns `ALLOW` / `STEP_UP` / `DENY` with a machine-readable reason code from a closed enum of 21. One function, readable top to bottom in one pass. Hand-written up to the `v1.0-submission` tag, and changed since then only under the rules in D-27.

**3. Ledger:** append-only, hash-chained, Merkle-checkpointed. Every intent, decision, API call and outcome. Immutability enforced by Postgres triggers rejecting UPDATE and DELETE, not by application convention. Spend is *derived by replaying the ledger*, never stored on the mandate, so inflating a budget requires forging the whole chain.

## System view

```
[human] --signs mandate--> [agent] <--MCP--> [merchant catalog · UNTRUSTED]
                              |
                              | PurchaseIntent (sku + qty only)
                              v
        ╔═════════════════ TRUST BOUNDARY ═════════════════╗
        ║  verify sig → derive state → evaluate() → gate   ║
        ║       │                                          ║
        ║   ALLOW → idempotency guard → PayPal or Razorpay ║
        ║   STEP_UP → human approval                       ║
        ║   DENY → typed reason code, nothing executes     ║
        ║       │                                          ║
        ║   append-only hash-chained ledger ───────────────╫──> /r/:trace_id
        ╚══════════════════════════════════════════════════╝
```

Evaluation and execution run in **two phases**, not one transaction: a database transaction and an external payment call cannot be made atomic (there is no protocol between them). What's guaranteed instead is that no call to a payment provider is ever made without a durable, committed record naming what was about to happen, so a crash or ambiguous failure between the call and recording its outcome leaves a resolvable trail, not a silent gap. A per-mandate advisory lock, held in both phases, still stops concurrent duplicate intents from racing the budget. See D-22.

## Stack

TypeScript (strict) · Postgres + Prisma · Ed25519 via `node:crypto` · a provider-neutral model interface (Gemini and Anthropic implementations) with tool use · MCP for the merchant catalog · PayPal Orders v2, Vault v3, Refunds and webhooks, sandbox only · Razorpay Node SDK, test mode only · AG Grid and AG Charts Community for the ledger console · Render (Blueprint, free plan) with Postgres on Neon for the hosted demo · Vitest + a custom eval runner in CI.

No HTTP framework. The control plane is a `runIntent()` orchestrator, called by the CLI, by the demo's routes and by the MCP gateway.

Deliberately boring where boring is correct. The novelty budget is spent on the decision layer, not the framework. **No vector database**: the catalog is small and structured, there is nothing to retrieve semantically, and adding one would have been decoration.

## How it's measured

| Metric | What it means |
|---|---|
| Containment rate | adversarial cases where no money moved (dev *and* held-out, reported separately) |
| Incidental containment | contained, but for an unrelated reason: a lucky pass, reported not hidden |
| False-refusal rate | benign purchases wrongly blocked: the cost side of the ledger |
| Money-at-risk prevented | value of contained attacks, per currency |
| Unresolved exceptions | explicit list of failing case IDs, each with a reason |

54 cases: 46 deterministic Layer 1 cases and 8 Layer 2 cases with a live model. Layer 1 covers prompt injection, mandate evasion, double-charge, numeric confusion, hallucinated SKU, scope drift, denial probes, order holds and 16 benign purchases. 42 Layer 1 cases also run mirrored on the other rail. The held-out split is a hash of each case id; the README says exactly what came before it, and why it is 20 of 46 rather than 30%.

Layer 1 runs in GitHub Actions on every push (`pnpm eval --layer1`) and fails the build on any failing case. Layer 2 needs a live model and is run by hand. The numbers in the README come from `eval/report.md`, which a full `pnpm eval` run writes.

## Scope and honesty

- PayPal sandbox and Razorpay test mode only. No live keys, no real money.
- Not a UAP implementation. UAP is unpublished.
- Not an AP2 or ACP implementation. [`PROTOCOLS.md`](PROTOCOLS.md) maps the mandate onto both, field by field, and lists the gaps.
- Single-merchant demo scope; multi-merchant is config, untested at scale.
- Merkle roots are computed but not externally anchored.
- `TRUNCATE ledger_entry` bypasses the append-only triggers entirely; they
  are row-level (`BEFORE UPDATE`/`BEFORE DELETE`) and Postgres never fires
  row-level triggers for a `TRUNCATE`. The ledger's integration tests rely on
  this to reset state between runs. Closing it needs a statement-level event
  trigger (`ON TRUNCATE`), not implemented.
- Execution is two-phase (D-22). A call whose outcome is unknown holds its
  budget and a velocity slot until the reconcile sweep settles it, so a
  pending call fails closed. Before D-42 attempts in flight weren't counted,
  and 20 concurrent intents created 4 times a mandate's budget.
- Mandate revocation implemented; delegation chains are not.
- **Defense only.** The adversarial corpus is a fixed set of static fixtures exercised against this project's own sandbox. Praman ships no attack generator and nothing that generalises to third-party systems.
- Known failures are listed in `eval/report.md` rather than tuned away.

## Built with

Praman was designed and built with Claude as a pair-programming partner. Every architectural decision in `DECISIONS.md` is mine, made deliberately and defended there, except those marked as an implementer's decision for me to check. Up to the `v1.0-submission` tag, the policy engine's `evaluate()` was hand-written, and Claude generated much of the surrounding scaffolding (types, serialisation, test cases) from specifications I wrote, which I reviewed line by line. The commit history shows the sequence: specification, then core, then plumbing, then measurement. Since 2026-11-04 the project follows an agentic development life cycle, by my decision (D-27): agents may edit `evaluate.ts`, with a failing test first, its own commit, and, since 2026-11-07, an independent agent's review rather than mine (D-80).