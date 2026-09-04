# Praman — Architecture

*This is the reviewer-facing document. Five minutes end to end. `HLD.md` and `LLD.md` go deeper; `DECISIONS.md` records why.*

---

## What this is

A control plane that sits between an AI buyer agent and a Razorpay merchant, making every rupee the agent moves **bounded, explainable, and replayable**.

> The model proposes. The policy engine disposes. The ledger remembers.

## Why it exists

NPCI is building the Unified Agent Protocol so AI agents can transact over UPI. Razorpay and NPCI piloted agentic UPI payments on Claude in February 2026, using consent-based per-merchant spending limits. The rails are arriving.

What isn't arriving is the layer that answers the question every risk team asks: **when an agent spends money it shouldn't have, how do you find out, prove it, and get it back?**

Today's agentic checkout reads attacker-controllable text (a merchant's product description) and then calls a payment API. That is prompt injection with a bank account attached, and there is no record of *why* the model decided anything.

## The one idea

Most approaches try to make the model safe. Praman makes the model **irrelevant to authorisation**.

The `PurchaseIntent` the agent emits contains a SKU and a quantity — and nothing else. No price. No merchant override. No scope.

```jsonc
{ "mandate_id": "mnd_…", "merchant_id": "MERCH_001",
  "line_items": [{ "sku": "SKU_MEALS_042", "qty": 2 }] }
```

The amount is resolved server-side from the catalog, *after* the SKU and its category have been validated against a signed, human-issued mandate. A product page that says "this item costs ₹1" cannot influence the charge, because the model never handles the number.

Injection can make the model *want* the wrong thing. It cannot make the system *charge* the wrong thing.

## The three primitives

**1. Mandate** — a human-signed (Ed25519) grant of bounded authority: merchant allowlist, category allowlist, per-transaction cap, cumulative cap, velocity limit, validity window, human-approval threshold. Modelled on the delegation-plus-limit pattern from UPI Circle and the Razorpay–NPCI pilot. Protocol-agnostic by design, since UAP is unpublished.

**2. Policy engine** — a pure, total, deterministic function of `(intent, mandate, ledger_state, catalog, now)`. No I/O, no clock, no randomness, **no LLM**. Returns `ALLOW` / `STEP_UP` / `DENY` with a machine-readable reason code from a closed enum of 17. Hand-written, ~150 lines, readable top to bottom in one pass.

**3. Ledger** — append-only, hash-chained, Merkle-checkpointed. Every intent, decision, API call and outcome. Immutability enforced by Postgres rules rejecting UPDATE and DELETE, not by application convention. Spend is *derived by replaying the ledger*, never stored on the mandate — so inflating a budget requires forging the whole chain.

## System view

```
[human] --signs mandate--> [agent] <--MCP--> [merchant catalog · UNTRUSTED]
                              |
                              | PurchaseIntent (sku + qty only)
                              v
        ╔═════════════════ TRUST BOUNDARY ═════════════════╗
        ║  verify sig → derive state → evaluate() → gate   ║
        ║       │                                          ║
        ║   ALLOW → idempotency guard → Razorpay test mode  ║
        ║   STEP_UP → human approval                       ║
        ║   DENY → typed reason code, nothing executes     ║
        ║       │                                          ║
        ║   append-only hash-chained ledger ───────────────╫──> /r/:trace_id
        ╚══════════════════════════════════════════════════╝
```

Evaluation and execution run in **two phases**, not one transaction: a database transaction and an external Razorpay call cannot be made atomic (there is no protocol between them). What's guaranteed instead is that no call to Razorpay is ever made without a durable, committed record naming what was about to happen — so a crash or ambiguous failure between the call and recording its outcome leaves a resolvable trail, not a silent gap. A per-mandate advisory lock, held in both phases, still stops concurrent duplicate intents from racing the budget. See D-22.

## Stack

TypeScript (strict) · Express · Postgres + Prisma · Ed25519 via `node:crypto` · Anthropic SDK with tool use · MCP for the merchant catalog · Razorpay Node SDK, test mode only · Vitest + a custom eval runner in CI.

Deliberately boring where boring is correct. The novelty budget is spent on the decision layer, not the framework. **No vector database** — the catalog is small and structured, there is nothing to retrieve semantically, and adding one would have been decoration.

## How it's measured

| Metric | What it means |
|---|---|
| Containment rate | adversarial cases where no money moved (dev *and* held-out, reported separately) |
| Incidental containment | contained, but for an unrelated reason — a lucky pass, reported not hidden |
| False-refusal rate | benign purchases wrongly blocked — the cost side of the ledger |
| Money-at-risk prevented | rupee value of contained attacks |
| Unresolved exceptions | explicit list of failing case IDs, each with a reason |

100 corpus cases: 60 adversarial across 8 families (prompt injection, mandate evasion, double-charge, numeric confusion, hallucinated SKU, scope drift, failure handling, catalog tamper) and 40 benign. A 30% held-out split was computed and committed *before* any tuning — the git history proves the ordering.

Run in GitHub Actions on every push. The README badge is generated from `report.json`, so the numbers can't drift from reality.

## Scope and honesty

- Test mode only. No live keys, no real money.
- Not a UAP implementation — UAP is unpublished.
- Single-merchant demo scope; multi-merchant is config, untested at scale.
- Merkle roots are computed but not externally anchored.
- `TRUNCATE ledger_entry` bypasses the append-only triggers entirely — they
  are row-level (`BEFORE UPDATE`/`BEFORE DELETE`) and Postgres never fires
  row-level triggers for a `TRUNCATE`. The ledger's integration tests rely on
  this to reset state between runs. Closing it needs a statement-level event
  trigger (`ON TRUNCATE`), not implemented.
- Execution is two-phase (D-22): between the ledger recording an attempt and
  recording its outcome, `deriveState` doesn't count that spend — a
  concurrent intent under the same mandate can evaluate against a slightly
  understated budget for the width of one API call. Deferred, not hidden.
- Mandate revocation implemented; delegation chains are not.
- **Defense only.** The adversarial corpus is a fixed set of static fixtures exercised against this project's own sandbox. Praman ships no attack generator and nothing that generalises to third-party systems.
- Known failures are listed in `eval/report.md` rather than tuned away.

## Built with

Praman was designed and built with Claude as a pair-programming partner. Every architectural decision in `DECISIONS.md` is mine, made deliberately and defended there. The policy engine's `evaluate()` is hand-written. Claude generated much of the surrounding scaffolding — types, serialisation, test cases — from specifications I wrote, and I reviewed and understand every line. The commit history shows the sequence: specification, then core, then plumbing, then measurement.