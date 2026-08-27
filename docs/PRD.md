# Praman — Product & Technical Specification

**Praman** (प्रमाण — *proof*) is a control plane for agent-initiated payments. It sits between an AI buyer agent and a Razorpay merchant, and makes every rupee an agent moves **bounded, explainable, and replayable**.

- **Submission:** Razorpay AI Buildathon 2026, Track 01 — AI Growth & Agentic Commerce
- **Builder:** Adwaith R Nair (solo)
- **Window:** 27 Aug – 5 Sep 2026
- **Repo:** `praman` (public, MIT)

---

## 1. The problem

NPCI is building the Unified Agent Protocol to let AI agents transact over UPI. Razorpay and NPCI already piloted agentic UPI payments on Claude in Feb 2026 with per-merchant consent limits. The rails are arriving.

What is not arriving is the layer that answers the question every risk team asks: **when an agent spends money it shouldn't have, how do you find out, prove it, and get the money back?**

Today an agentic checkout looks like this:

```
[LLM] --reads merchant page--> [decides] --calls payment API--> [money gone]
```

There is no gate, no bound, and no record of *why* the model decided what it decided. The merchant's product description is untrusted input that flows straight into a system with spend authority. That is a prompt-injection surface attached to a bank account.

Praman inserts a deterministic layer in the middle:

```
[LLM] --proposes intent--> [PRAMAN] --evaluates against signed mandate--> ALLOW / STEP_UP / DENY
                               |
                               +--> append-only hash-chained ledger --> replayable receipt
```

**One-line pitch:** *The model proposes. The policy engine disposes. The ledger remembers.*

---

## 2. Non-negotiable design principles

These are what the panel will probe. Every one of them is a decision you must be able to defend without notes.

1. **No LLM in the decision path.** The model may *propose* a purchase intent. It may never *authorise* one. Authorisation is a pure, deterministic, side-effect-free function of `(intent, mandate, ledger_state)`. This is the entire architecture in one sentence.
2. **Untrusted content is never an instruction.** Merchant catalog text, product descriptions, and API responses are data. They are passed to the model inside a delimited, labelled block, and the system prompt states that content inside it can never change policy, price, or scope.
3. **Money is integer paise.** Never a float, never a string, never rupees. Every amount field is `_paise` suffixed and typed as `bigint`.
4. **Every money action is idempotent.** `idempotency_key = sha256(mandate_id || canonical_json(intent))`. A retried intent hits the same key and returns the original outcome instead of charging twice.
5. **The ledger is append-only at the database level**, not by convention. A Postgres rule/trigger rejects `UPDATE` and `DELETE` on the ledger table. Tamper-evidence is enforced by the storage layer, not by application discipline.
6. **Refusals are typed.** Every `DENY` and `STEP_UP` carries a machine-readable reason code from a closed enum. "The agent refused" is not an outcome; `MANDATE_AMOUNT_EXCEEDED` is.
7. **Defense only.** The adversarial corpus is a fixed set of test fixtures against your own sandbox. Praman ships no attack generator, no injection-payload synthesiser, nothing that generalises to third-party systems. State this in the README.

---

## 3. System architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  BUYER SIDE                                                      │
│  buyer-agent  (Claude + tool use)                                │
│   • reads goal: "order lunch under ₹400"                         │
│   • discovers catalog via MCP                                    │
│   • proposes PurchaseIntent  ─────────────┐                      │
└───────────────────────────────────────────┼──────────────────────┘
                                            │  POST /v1/intents
┌───────────────────────────────────────────▼──────────────────────┐
│  PRAMAN CONTROL PLANE  (Express + TypeScript)                    │
│                                                                  │
│  ┌────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │ Mandate Store  │→ │  POLICY ENGINE   │→ │ Idempotency Guard│  │
│  │ Ed25519 verify │  │  pure function   │  │  key → outcome   │  │
│  └────────────────┘  └────────┬─────────┘  └────────┬─────────┘  │
│                               │ ALLOW               │            │
│                      STEP_UP / DENY          ┌──────▼─────────┐  │
│                               │              │ Razorpay Exec  │  │
│                               │              │ test-mode SDK  │  │
│                               │              └──────┬─────────┘  │
│  ┌────────────────────────────▼─────────────────────▼─────────┐  │
│  │  LEDGER  — append-only, hash-chained, Merkle-rooted        │  │
│  │  intent → decision → api_call → outcome → settlement       │  │
│  └────────────────────────────┬───────────────────────────────┘  │
└───────────────────────────────┼──────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
  Receipt UI            Dispute Bundle           Eval Harness
  /r/:trace_id          (JSON evidence)          (CI, held-out set)

┌──────────────────────────────────────────────────────────────────┐
│  MERCHANT SIDE                                                   │
│  merchant-mcp — MCP server exposing catalog, stock, refund policy │
│  (this is the "agent-readable catalog" from the track brief)      │
└──────────────────────────────────────────────────────────────────┘
```

### Components

| # | Component | Purpose | Priority |
|---|-----------|---------|----------|
| C1 | `packages/policy` | Pure decision function. **Hand-written by you.** | P0 |
| C2 | `packages/ledger` | Hash-chained append-only log + Merkle root + verifier CLI | P0 |
| C3 | `apps/control-plane` | Express API: `/v1/intents`, `/v1/mandates`, `/v1/traces` | P0 |
| C4 | `packages/razorpay-exec` | Test-mode order/payment execution, idempotent, with retry+escalate | P0 |
| C5 | `apps/eval` | Adversarial + benign corpus runner, metrics report, CI | P0 |
| C6 | `apps/merchant-mcp` | MCP server: catalog, pricing, stock, policy | P1 |
| C7 | `apps/buyer-agent` | Claude agent that plans and proposes intents | P1 |
| C8 | `apps/receipt-ui` | Public replay page for a trace | P1 |
| C9 | `packages/dispute` | Chargeback evidence bundle generator | P2 |

**Cut order under time pressure: C9 → C8 → C6.** Never cut C1, C2, or C5. Those *are* the submission.

---

## 4. Tech stack and why (rehearse these answers)

| Choice | Reason you will give the panel |
|---|---|
| **TypeScript, strict, `noUncheckedIndexedAccess`** | The policy engine's correctness is the product. A type system that makes an unhandled reason code a compile error is worth more than runtime speed. |
| **Express + TypeScript** | Boring on purpose. The interesting risk in this system is in the decision logic, not the HTTP layer. I didn't want to spend novelty budget on the framework. |
| **Postgres + Prisma** | The ledger needs transactional append and DB-enforced immutability. I add a rule that rejects UPDATE/DELETE on `ledger_entry`. A document store would have left immutability as a convention I could break by accident. |
| **Ed25519 via `node:crypto`** | Mandates are signed by the issuer (the human). Small keys, fast verify, no external dependency in the trust path. |
| **Anthropic SDK, tool use, `claude-sonnet-4-6`** | The agent needs structured tool calls, not free text. Tool use gives me a typed intent object I can validate before it reaches the policy engine. |
| **MCP for the merchant catalog** | The track asks for a merchant that is transactable by an AI buyer. MCP is the interop standard the buyer side actually speaks, and Razorpay ships its own MCP server — so the merchant speaking MCP is the natural shape. |
| **Razorpay Node SDK + test-mode keys (`rzp_test_`)** | Real API surface, no real money. All order/payment/refund lifecycle is exercised against Razorpay's sandbox. |
| **Vitest + a custom eval runner in CI** | Evals are tests. Running them in GitHub Actions on every commit means the containment numbers in the README can't rot. |
| **No vector DB** | Deliberate. There is nothing here to retrieve semantically — the catalog is small and structured. Adding a vector store would have been resume decoration, not architecture. *(This is a strong answer. Have it ready.)* |

---

## 5. Core flow, step by step

**Setup (once):** the human issues a mandate — "my agent may spend up to ₹5,000 total, max ₹800 per transaction, only at merchant `MERCH_001`, only in category `food`, valid 24h, anything over ₹500 needs my approval." Signed with the issuer's Ed25519 key.

**Runtime:**

1. Buyer agent receives a goal in natural language.
2. Agent calls `merchant-mcp` tools to browse the catalog. **All returned text is wrapped in `<untrusted_merchant_content>` before it reaches the model.**
3. Agent emits a `PurchaseIntent` via tool use — structured, typed, no prose.
4. `POST /v1/intents` with the intent + mandate JWT.
5. Control plane verifies the mandate signature and expiry.
6. **Policy engine** evaluates. Returns `{ decision, reason_code, explanation, remaining_budget_paise }`.
7. Ledger appends `intent` and `decision` entries (hash-chained).
8. On `ALLOW`: idempotency guard checks the key, then Razorpay test-mode order + payment. Ledger appends `api_call` and `outcome`.
9. On `STEP_UP`: a pending approval record is created; the flow blocks. A human approves or rejects via the receipt UI. Either way it's in the ledger.
10. On `DENY`: nothing is executed. The agent receives the reason code and must re-plan within bounds — it cannot retry its way past the gate, because the idempotency key is derived from the intent.
11. Any trace is replayable at `/r/:trace_id`, showing every step including the model's tool call verbatim.

### The failure path (they asked for this by name)

Force a Razorpay test-mode payment failure. The agent must:
- receive the typed failure,
- diagnose it (`PAYMENT_METHOD_DECLINED`),
- retry **once** on an alternate method — with a *new* idempotency key derived from the new intent,
- and if the retry would breach the mandate, stop and escalate to human approval instead of looping.

Demonstrating the *stop* is worth more than demonstrating the retry.

---

## 6. What the demo must show, in order

1. A blocked purchase, with the receipt page explaining exactly why. **Lead with this.**
2. A successful bounded purchase, end to end, on Razorpay test mode.
3. A prompt-injection attempt inside a product description, contained, with the ledger showing the model was influenced and the policy engine refused anyway. *This is the moneyshot: it proves the architecture, not just the feature.*
4. The failure-and-escalate path.
5. `npm run eval` output: containment rate, false-refusal rate, money-at-risk prevented.
6. `npm run verify-ledger` proving the chain is unbroken, then a manual DB tamper attempt showing verification failing.

That last one lands hard in a room full of payments people.

---

## 7. Out of scope (say so in the README)

Stating limits honestly is scored. Do not hide these.

- No real money, no live keys, test mode only.
- Not a UAP implementation — UAP is unpublished. Praman is modelled on the delegation-plus-limit pattern from UPI Circle and the Razorpay–NPCI pilot, and is protocol-agnostic.
- Single-merchant scope in the demo; multi-merchant is a config change, untested at scale.
- Mandate revocation is implemented; mandate delegation chains are not.
- No offense-capable tooling of any kind.