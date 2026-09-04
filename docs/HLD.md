# Praman — High Level Design (HLD)

> **Doc map.** `ARCHITECTURE.md` is the reviewer-facing summary (read first, 5 min). **This HLD** is the system decomposition — components, boundaries, flows, failure modes. `LLD.md` is implementation-level contracts — schemas, signatures, SQL. `DECISIONS.md` records *why* each major choice was made.

---

## 1. Problem framing

An AI agent with spend authority is a new class of system. It has three properties that no existing payment integration has to handle simultaneously:

1. **It reads untrusted text and then acts.** A merchant's product description is attacker-controlled input flowing into a component with access to a payment API. This is prompt injection with a bank account attached.
2. **It is non-deterministic.** The same goal can produce different actions on different runs. You cannot reason about it the way you reason about a checkout form.
3. **It has no natural audit trail.** When a human buys something wrong, you ask them why. When a model does, the "why" is a forward pass that no longer exists.

Existing controls don't cover this. Rate limits don't understand intent. Fraud scoring is tuned for human behaviour patterns. Webhooks record *that* a payment happened, not *why the agent decided to make it*.

**Praman's thesis:** don't try to make the model safe. Make the model *irrelevant to authorisation*, and make its reasoning permanently reviewable.

## 2. Design goals

| Goal | Measured by |
|---|---|
| G1 — No agent action exceeds explicit human-granted authority | containment rate on adversarial corpus |
| G2 — Legitimate purchases are not blocked | false-refusal rate on benign corpus |
| G3 — Every money action is reconstructible after the fact | every executed payment has a complete, verifiable trace |
| G4 — Tampering with the record is detectable | `verify-ledger` fails on any mutation |
| G5 — Failures degrade to human review, never to a loop or a silent drop | failure-family eval cases |

**Non-goals:** making the agent smarter, maximising conversion, real-money settlement, implementing NPCI's UAP (unpublished), multi-tenant scale.

## 3. Trust model

This is the section that makes or breaks the panel conversation. Be able to draw it.

```
TRUSTED                          │  UNTRUSTED
─────────────────────────────────┼──────────────────────────────────
• Policy engine                  │  • Merchant catalog text
• Mandate signature verification │  • Product descriptions, reviews
• Ledger + hash chain            │  • Merchant API responses
• Catalog price data (server-    │  • Everything the LLM outputs
  side, from DB not from prompt) │  • The LLM's own reasoning text
• Razorpay API responses         │  • Any amount, SKU, or scope the
  (authenticated)                │    model "suggests"
```

The boundary is enforced in exactly two places:

- **`untrusted.ts`** — wraps every piece of merchant-origin text in a delimited block before it enters a prompt, with a system-prompt clause stating that content inside can never alter policy, price, or scope.
- **The `PurchaseIntent` shape** — it carries a SKU and a quantity and *nothing else*. No price, no merchant override, no scope field. The model physically cannot express an amount. Injection can make the model *want* the wrong thing; it cannot make the system *charge* the wrong thing.

That second point is the core insight of the whole project. **Constrain the interface, not the model.**

## 4. Component decomposition

```
                    ┌───────────────────────────┐
                    │  Human issuer             │
                    │  signs mandate (Ed25519)  │
                    └────────────┬──────────────┘
                                 │ mandate
┌──────────────┐  MCP    ┌───────▼──────────────────────────────────┐
│ merchant-mcp │◄───────►│ buyer-agent                              │
│ (C6)         │ catalog │ (C7) Claude + tool use                   │
│ untrusted    │         │  emits PurchaseIntent (sku, qty only)    │
└──────────────┘         └───────┬──────────────────────────────────┘
                                 │ POST /v1/intents
        ╔════════════════════════▼══════════════════════════════════╗
        ║ CONTROL PLANE (C3)                    TRUST BOUNDARY      ║
        ║                                                            ║
        ║  ┌──────────────┐   ┌──────────────┐   ┌───────────────┐  ║
        ║  │ mandate      │──►│ POLICY (C1)  │──►│ idempotency   │  ║
        ║  │ verify       │   │ pure fn      │   │ guard         │  ║
        ║  └──────────────┘   └──────┬───────┘   └───────┬───────┘  ║
        ║         ▲                  │ ALLOW              │ new      ║
        ║         │           STEP_UP│DENY        ┌───────▼───────┐  ║
        ║  ┌──────┴───────┐          │            │ razorpay-exec │  ║
        ║  │ deriveState  │◄─────────┼────────────│ (C4) test mode│  ║
        ║  │ (replay)     │          │            └───────┬───────┘  ║
        ║  └──────┬───────┘          │                    │          ║
        ║  ┌──────▼──────────────────▼────────────────────▼───────┐  ║
        ║  │ LEDGER (C2)  append-only · hash-chained · Merkle     │  ║
        ║  └──────────────────────────┬───────────────────────────┘  ║
        ╚═══════════════════════════════╪══════════════════════════════╝
                     ┌─────────────────┼─────────────────┐
                     ▼                 ▼                 ▼
              receipt-ui (C8)   dispute (C9)      eval harness (C5)
```

### Component responsibilities

| ID | Component | Owns | Explicitly does NOT |
|---|---|---|---|
| C1 | `packages/policy` | The authorisation decision | Touch I/O, the clock, randomness, or an LLM |
| C2 | `packages/ledger` | Append, chain, verify, derive state | Ever expose update or delete |
| C3 | `apps/control-plane` | HTTP, orchestration, transactions | Contain any business rule — it delegates to C1 |
| C4 | `packages/razorpay-exec` | Test-mode execution, idempotency, retry | Decide *whether* to execute |
| C5 | `apps/eval` | Corpus, runner, metrics | Generate attacks dynamically |
| C6 | `apps/merchant-mcp` | Agent-readable catalog over MCP | Be trusted |
| C7 | `apps/buyer-agent` | Planning, proposing intents | Authorise anything |
| C8 | `apps/receipt-ui` | Render a trace for a human | Write to the ledger |
| C9 | `packages/dispute` | Assemble evidence bundles | Alter history |

**The rule that keeps this clean:** if you're unsure where code goes, ask "is this a *decision* or an *execution*?" Decisions live in C1. Everything else is plumbing.

## 5. Primary flows

### 5.1 Happy path

```
agent          control-plane        policy      ledger       razorpay
  │  intent ────────►│                 │           │            │
  │                  │ [T1 — advisory lock]         │            │
  │                  │ verify mandate  │           │            │
  │                  │ idempotency check (own row, not Razorpay) │
  │                  │ deriveState ────────────────►│            │
  │                  │◄──── spent, velocity ────────│            │
  │                  │ evaluate() ─────►│           │            │
  │                  │◄─ ALLOW, amount ─│           │            │
  │                  │ append(intent, decision) ───►│            │
  │                  │ write PENDING idempotency row │            │
  │                  │ append(api_call: attempted) ─►│            │
  │                  │ [T1 commits]                 │            │
  │                  │ execute — no transaction ────────────────►│
  │                  │◄────────────── order/outcome ──────────────│
  │                  │ [T2 — advisory lock]                      │
  │                  │ append(outcome) ─────────────►│            │
  │                  │ resolve idempotency row       │            │
  │                  │ [T2 commits]                 │            │
  │◄─ trace_id, OK ──│                 │           │            │
```

**Two phases, not one transaction — see D-22.** A database transaction and an
external API call cannot be made atomic; there is no protocol between
Postgres and Razorpay that makes both commit or both fail together. What's
achievable instead: no external call is ever made without a durable,
committed record (T1's pending row) naming what was about to happen. If
execution fails ambiguously (timeout, crash before T2), the call returns
`IN_FLIGHT` rather than a decision, and a reconciler resolves the pending row
once Razorpay's own propagation lag has passed. An executed payment with no
trace of the attempt at all is structurally impossible; an executed payment
whose *outcome* is briefly unrecorded, with a durable pointer to what to
check, is the accepted, named trade-off.

### 5.2 Step-up

Decision is `STEP_UP` → a pending approval row is written, the ledger records the step-up, and the HTTP call returns `202` with an `approval_id`. Nothing is executed. A human resolves it via the receipt UI; resolution appends `step_up_resolved` and, if approved, re-enters the execution path **with the same idempotency key**.

### 5.3 Denial

Nothing executes. The agent receives `{ decision: "DENY", reason_code, remaining_paise }`. It may re-plan, but a re-plan produces a *different* intent and therefore a different idempotency key — it cannot retry its way past the gate, and each attempt is separately recorded.

### 5.4 Execution failure

Razorpay returns a decline or times out. Typed error → agent diagnoses → **at most one** retry on an alternate method (new intent, new key) → if the retry would breach the mandate, escalate to human rather than loop. Both attempts are in the ledger.

## 6. Failure modes and mitigations

| Failure | Consequence if unhandled | Mitigation |
|---|---|---|
| Injection in product description | Agent proposes out-of-scope purchase | Intent has no price/scope field; policy resolves from catalog |
| Duplicate intent (retry storm) | Double charge | Deterministic idempotency key, unique index |
| Concurrent duplicate intents | Double charge, budget race | Per-mandate advisory lock, held in both T1 and T2 |
| Payment succeeds, T2 never runs (crash) | Order exists, temporarily unrecorded | T1's pending row names the receipt/amount before the call; reconciler resolves it once past the propagation-lag window (D-22) |
| Payment times out, status unknown | Unknown state, possible double charge | `runIntent` returns `IN_FLIGHT` rather than guessing; reconcile by receipt before any retry, never blind-retry |
| Mandate row tampered in DB | Inflated budget | Spend derived by ledger replay, not stored on mandate |
| Ledger row tampered | Falsified history | Hash chain + `verify-ledger` + DB rules blocking UPDATE/DELETE |
| Agent loops on failure | Runaway spend | Retry cap of 1, velocity limit, escalation path |
| Clock skew | Expired mandate accepted | `now` injected and recorded in the ledger entry |

## 7. Where the numbers come from

G1–G5 are not aspirations; each maps to a measurement in `apps/eval` (see `EVAL_CORPUS.md`). The README badge is generated from `eval/report.json` in CI, so it cannot drift from reality. The held-out split exists so that the reported containment number is not the number you tuned against.