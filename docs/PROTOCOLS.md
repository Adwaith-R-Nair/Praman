# Praman beside AP2, ACP and PayPal's agent tools

Praman's signed mandate was modelled on the consent-plus-limit pattern of UPI Circle and the Razorpay and NPCI agentic UPI pilot, not on a payments protocol. This page maps it, field by field, onto two public protocols a PayPal reader already knows:

- **AP2**, the Agent Payments Protocol that Google started and PayPal has written about, at version 0.2.
- **ACP**, the Agentic Commerce Protocol from OpenAI, which PayPal has adopted, and in particular its delegated payment allowance.

**Praman implements neither protocol and is not compliant with either.** Nothing in this repo has been run against an AP2 sample or an ACP endpoint. The mandate is AP2-shaped: the same idea, in a different format, with gaps that section 4 lists. The mapping is here so a reader can place Praman quickly and see what it would take to close the distance.

The specs and PayPal's pages were read on 9 Nov 2026. Section 7 has every link. Where a spec page did not say something, this page says "not in the pages read" and does not guess.

## 1. The short version

| Question AP2 asks | Praman's answer | Where |
|---|---|---|
| **Authorization.** Did the user give the agent this authority? | An Ed25519 signature over the mandate's canonical JSON, verified before `evaluate()` runs | `packages/mandate`, `packages/control-plane/src/run-intent.ts` |
| **Authenticity.** Does the request reflect what the user meant? | The agent names a SKU and a quantity. The price comes from the catalog, and `evaluate()` checks the cart against the signed limits. No model output is a price or a limit | `packages/policy/src/evaluate.ts` |
| **Accountability.** Who answers when it goes wrong? | Every intent, decision, call and outcome is a row on an append-only, hash-chained ledger, and any trace exports as a dispute bundle with the signed mandate | `packages/ledger`, `packages/dispute` |

Those three words are AP2's own, from its home page.

## 2. Two vocabularies for the same thing

PayPal's 2025 writing uses AP2's first vocabulary. The current spec uses another. This page uses both so either reader recognises it.

| AP2 v0.1, and PayPal's posts | AP2 v0.2 | Meaning |
|---|---|---|
| Intent Mandate, human not present | open Checkout Mandate and open Payment Mandate | The user signs constraints ahead of time and the agent acts later |
| Cart Mandate, human present | closed Checkout Mandate | One finished cart that the user approves |
| Payment Mandate | closed Payment Mandate | The payment for that cart, shown to the processor, network and issuer |

A Praman mandate is the first row: limits signed ahead of time, used by an agent later.

## 3. The mandate, field by field

The field names are from [`MANDATE_SPEC.md`](MANDATE_SPEC.md), section 1. "Direct" means the same rule with a different name. "Loose" means the nearest concept, with a real difference. "None" means the protocol pages read have no place for it.

| Praman field | What it does in Praman | AP2 v0.2 | ACP allowance | Fit |
|---|---|---|---|---|
| `mandate_id` | Names the mandate. Every ledger row and intent carries it | No id field in the pages read. A receipt points at a mandate by a hash of it (`reference`). PayPal's post speaks of "mandate IDs and signatures" | `checkout_session_id` ties an allowance to one checkout | Loose |
| `version` | Selects the field names, and is inside the signed bytes. An unknown version is refused | `vct`, such as `mandate.payment.open.1`. The version suffix must match exactly | None in the allowance | Direct for AP2 |
| `issuer_id` | The person who grants the authority | The user who signs on a Trusted Surface | None. The buyer is whoever is in the chat session | Loose |
| `subject_id` | Names the agent. It is a signed label and nothing checks it against the caller | `cnf`: the agent's public key. The agent proves it holds the key when it closes the mandate | None | **Gap.** See 4.2 |
| `scope.merchant_ids` | Closed allowlist. A merchant not listed is refused with `MERCHANT_OUT_OF_SCOPE` | `payment.allowed_payees` and `checkout.allowed_merchants` | `merchant_id`, one merchant | Direct |
| `scope.categories` | Closed allowlist of product categories. Anything else is `CATEGORY_OUT_OF_SCOPE` | No standard constraint. The nearest is `checkout.line_items`, which lists acceptable item ids, not categories | None | None. A Praman addition |
| `scope.currency` | The only source of currency, `INR` or `USD`. Nothing is converted | `currency` on `payment.amount_range` and `payment.budget` | `currency` | Direct |
| `limits.max_per_txn_minor` | Cap on one purchase, in integer minor units, written as a decimal string | `payment.amount_range`, field `max` | `max_amount` | Direct |
| `limits.max_total_minor` | Cap on all purchases under the mandate. Spend is replayed from the ledger, never stored | `payment.budget`, field `max` | None. An allowance is `one_time` | Direct for AP2 |
| `limits.max_txns_per_window`, `limits.window_seconds` | At most this many purchases in a rolling window | Nearest is `payment.agent_recurrence` (`frequency`, `max_occurrences`), which is a schedule and not a rate limit | None | Loose |
| `limits.max_denials_per_window` | Locks the mandate after too many refusals, so limits can't be found by probing | None | None | None. A Praman addition |
| `step_up.threshold_minor` | At or above this amount a person must approve. The first purchase at any merchant also needs a person | No constraint type. AP2 has the two modes (human present, human not present) and lets a verifier answer `unresolved_constraint`, which "may trigger a fallback" to a mandate the user approves directly | Nearest is `risk_signals[].action`, with `authorized`, `manual_review` or `blocked`. That is the payment provider's risk verdict, not a limit the user set | Loose |
| `validity.not_before`, `validity.not_after` | The mandate works only inside this window | `payment.execution_date` (`not_before`, `not_after`), and the credential's `exp` | `expires_at` | Direct |
| `nonce` | Eight random bytes, so two mandates with the same terms are different documents | Closed mandates carry a `nonce`, and SD-JWT disclosures are salted | None | Loose |
| Revocation | Not a field in the signed document that the code reads, though the example in `MANDATE_SPEC.md` shows `revoked: false`. Revoking is a ledger append (`mandate_revoked`), checked on every decision | Not in the pages read | Expiry only | None. A Praman addition |
| `signature` (`alg`, `key_id`, `value`) | Ed25519 over the canonical JSON of the document. It sits beside the document, not inside it | An SD-JWT signed by the user's key. The examples use ES256 | None. The allowance is created by the agent platform calling the payment provider, with no user signature | **Gap** in format. See 4.1 |

### Around the mandate

| Praman | AP2 v0.2 | ACP | Fit |
|---|---|---|---|
| `PurchaseIntent`: SKU and quantity, with no price field. The price is read from the catalog | A closed Checkout Mandate holds `checkout_jwt`, a checkout the merchant signed. Open Checkout Mandate constraints have no price field either | The allowance caps one checkout session at `max_amount` | Same principle: the agent never states the price. Praman has no merchant signature. See 4.4 |
| `evaluate()` answers `ALLOW`, `STEP_UP` or `DENY` with one of 21 closed reason codes | The verifier returns a signed Mandate Receipt: `result` is `success` or `error`, with codes `invalid_credential`, `unresolved_constraint`, `invalid_mandate`, `mandates_not_supported` | Braintree's allowance checks: 915266 (amount), 915267 (currency), 91565 (unknown or expired) | Same role. Praman's decisions are ledger rows, not signed receipts. See 4.5 |
| A missing value denies. A category or merchant not on the list is refused | "Any unknown Constraints MUST be treated as failing evaluation." | Not stated in the pages read | Same fail-closed rule |
| A step-up approval is bound to the amount and currency shown. If either changed, it is refused (`AMOUNT_CHANGED_SINCE_APPROVAL`, `CURRENCY_MISMATCH`) | A closed mandate is bound to one checkout by `checkout_hash` | The allowance is bound to one `checkout_session_id` | Same binding idea |
| The MCP gateway's approval command refuses to run without a terminal. A PayPal checkout is approved on PayPal's own page | Trusted Surface: "a UI surface that is trusted to get informed user consent", which must be non-agentic | Not in the pages read | Loose. See 4.3 |
| A purchase under the threshold is charged to a saved PayPal account, with no buyer at PayPal | Human Not Present | Not the same thing: an ACP token is single use | Direct for AP2 |
| A purchase at or over the threshold is a PayPal checkout the buyer approves, then Praman re-checks the mandate and captures | Human Present | Not in the pages read | Direct for AP2 |
| The demo server holds the saved account's vault id and uses it only for an order the mandate allowed | Credential Provider: verifies the agent's authority and scopes the credential | The payment provider that issues the delegated token | Closest role, at sandbox scale |
| PayPal | Merchant Payment Processor | Payment service provider | Direct |
| The idempotency key is `sha256(mandate_id + canonical_json(intent))`, sent as `PayPal-Request-Id`. The caller can't choose it | Not in the pages read | `Idempotency-Key` header. Reuse with different parameters is a 409 `idempotency_conflict` | Direct for ACP. Praman derives the key and ACP trusts the caller's |
| The public dispute bundle withholds limits and names what it left out (`withheld_fields`), with a salt on the row so a hash can't confirm a guess | SD-JWT selective disclosure, with salted digests | None | Same purpose, different mechanism |
| The MCP gateway's tool that captures after the buyer pays is `complete_checkout` | Not applicable | PayPal's ACP guide has the merchant expose an MCP tool named `complete_checkout` | Same name. Praman's takes a `trace_id`, not a payment token |

## 4. The gaps, stated plainly

1. **No verifiable-credential format.** A Praman mandate is canonical JSON with an Ed25519 signature. AP2 mandates are SD-JWTs with selective disclosure. An AP2 verifier could not read a Praman mandate, and Praman could not read an AP2 one.
2. **No agent key binding.** `subject_id` is a name inside the signed document. There is no `cnf` claim, the agent holds no key, and nothing proves that the caller presenting a mandate is the agent it names. In the MCP gateway the mandate is a file the gateway process loads. Whoever can reach `runIntent` with that mandate acts as its agent.
3. **No user-held key and no trusted signing surface.** In the hosted demo the server signs each visitor's mandate with a demo key, and the pages say so. On the command line the key comes from `.env`. The public key in a dispute bundle is the one the server used, so it shows the mandate wasn't altered and does not show who held the key.
4. **No merchant-signed cart.** The price comes from Praman's own copy of the catalog. There is no `checkout_jwt`, and the merchant is not a party to the mandate.
5. **Decisions are not signed receipts.** A decision is a ledger row chained by hash to the row before it. It is not a JWT that a verifier signed and a third party can check on its own. Merkle roots are computed and are not anchored outside the database.
6. **No network tokens and no Payment Mandate.** Praman charges a PayPal wallet through Vault v3 payment tokens, in the sandbox. It uses no card network token and no ACP delegated payment token, and it sends nothing to an issuer or a card network. So the network never learns that an agent was involved, which is what AP2's Payment Mandate is for.
7. **Four limits have no standard constraint.** Category scope, the velocity window, the denial-rate cap and the step-up threshold would each need a new AP2 constraint type. A verifier that didn't know them would have to fail them, which is the right behaviour and also means they would not interoperate today.
8. **Amounts.** Praman uses integer minor units everywhere, as decimal strings in the signed document and `bigint` in code. The AP2 pages describe a closed mandate's amount as integer minor units, while the constraint examples read on 9 Nov use decimals such as `100.50`. A converter would have to settle that first.
9. **No interop test, and sandbox only.** No PayPal-hosted AP2 endpoint was found to test against. PayPal's ACP path runs through Braintree and its agentic commerce services, which need onboarding that a solo sandbox developer doesn't have.

What Praman has that the pages read do not cover: revocation that takes effect on the next decision, a cumulative budget replayed from an append-only ledger, a cap on refusals, and a step-up that re-runs every check at approval time.

## 5. What PayPal has said about mandates and seller protection

All quotations are from PayPal's or its partner's own pages. Nothing here is a statement about Praman.

**On mandates as evidence.** From "Agent Payments Protocol: Building Verifiable Trust for Agentic Commerce", PayPal developer blog, 16 Sep 2025 ([link](https://developer.paypal.com/community/blog/PayPal-Agent-Payments-Protocol/)):

- "Mandates are cryptographically signed records of user intent that anchor each transaction to verifiable evidence."
- The Intent Mandate is the human-not-present case, where "the user pre-approves defined conditions (e.g., budget, product categories, or timing)".
- Mandates "could add cryptographic artifacts that can be validated independently".
- Among the work PayPal lists next: "Extending Seller Protection workflows with Cart and Intent Mandates, mandate IDs and signatures".
- "Accountability tied to real-world entities such as the user, merchant or the issuer, and not the agent."

A Praman dispute bundle is built for that use: the hash-chained rows for one purchase in one JSON file, and in the owner's copy the signed mandate and the key that verified it. The public copy withholds the limits. No bundle has been submitted to PayPal as dispute evidence, and Praman calls no Disputes API.

**On the buyer staying in charge.** From "WebMCP is here", PayPal developer blog, 16 Sep 2026 ([link](https://developer.paypal.com/community/blog/WebMCP_PayPal_Agent_Ready)): "The buyer remains in charge of approving the transaction." and, of the agent, "It does not replace the shopper or take control of payment credentials."

Praman's saved-account charge has no buyer at PayPal at the moment of payment. The buyer's approval is moved earlier, into the signed mandate, and it comes back to a person at the threshold, at a new merchant and for every refund. The agent never holds the payment token.

**On what agentic commerce must have.** From PayPal's newsroom, January 2026 ([link](https://newsroom.paypal-corp.com/2026-01-22-Making-Sense-of-the-AI-Shopping-Protocol-Moment)): "clear consumer consent, trusted identity, reliable payments, and built-in fraud protection", and agents that act with "real permission from a real customer".

**On ACP.** From PayPal's newsroom, 28 Oct 2025 ([link](https://newsroom.paypal-corp.com/2025-10-28-OpenAI-and-PayPal-Team-Up-to-Power-Instant-Checkout-and-Agentic-Commerce-in-ChatGPT)): PayPal "will adopt the Agentic Commerce Protocol (ACP)", with "PayPal's buyer and seller protections, and post-purchase services such as tracking and dispute resolution."

**On AP2 with Google.** From the Google Cloud blog, 28 Oct 2025 ([link](https://cloud.google.com/blog/topics/financial-services/introducing-an-agentic-commerce-solution-for-merchants-from-paypal-and-google-cloud)): with PayPal's agent built to AP2, merchants "will be able to have the assurance that a user was present to authorize the payment", and trust is "anchored to deterministic, non-repudiable proof of intent from the user, which directly addresses the risk of agent error."

**On a gateway's duty.** From "What We Learned Building PayPal's MCP Gateway", PayPal developer blog, 8 Oct 2026 ([link](https://developer.paypal.com/community/blog/PayPal_MCP_Gateway)), about PayPal's internal gateway for its own tools: "Discovery never replaces the final authorization check." The authors list "clearer policy outcomes" among their next priorities.

**Not found.** No PayPal statement on who bears the loss when an agent goes beyond what its user allowed, and no PayPal API that accepts a mandate.

## 6. Where Praman sits beside PayPal's Agent Toolkit and MCP servers

**The toolkit is the hands. Praman is the permission.**

PayPal's [Agent Toolkit](https://developer.paypal.com/ai-tools/toolkit/) and its [MCP servers](https://developer.paypal.com/ai-tools/mcp-server/) turn PayPal's APIs into tools a model can call: `create_order`, `pay_order`, `create_refund`, invoices, subscriptions, disputes, shipment tracking and reporting. Their [tool reference](https://developer.paypal.com/ai-tools/agent-tools/) has no tool for Vault or payment tokens and no concept of a spend limit, a mandate or an approval. That is not a fault. Those tools do what a model asks. Whether the model should be asking is a separate question, and it is the one Praman answers.

```
   agent ──proposes SKU and quantity──▶ Praman ──only after ALLOW or a person's approval──▶ PayPal
                                          │
                                          └── every decision and call ──▶ ledger
```

- **Today Praman does not use the toolkit.** `packages/paypal-exec` calls PayPal's REST APIs directly: Orders v2, Vault v3, capture refunds and webhook signature verification. Praman's own MCP gateway (`apps/mcp-gateway`, [`MCP.md`](MCP.md)) gives an agent six tools, none with a field for a price, a currency, a rail or a mandate.
- **An agent must not hold both routes to money.** An agent connected to Praman's gateway and also to PayPal's MCP server with `create_order` enabled can pay without asking Praman. The gateway is the only route to money only if the agent has no other.
- **A safe pairing is read-only.** The toolkit's configuration turns actions on one by one, for example `orders: { get: true }` and `disputes: { list: true, get: true }`. With only read actions, a model could read PayPal's own record of an order and compare it with the ledger, and still could not move money. This repo does not ship that pairing. The page for `@paypal/mcp` documents only `--tools=all`, so no restricted command line is given here, because none was run.
- **Beside PayPal's internal MCP Gateway.** PayPal describes one governed path for its own tools, with identity kept per caller, an authorization check on each call, and audit events. Praman's gateway is that shape for one narrow job, spending under one signed mandate, with closed reason codes as the policy outcome and the ledger as the audit record. It is a single-user local server, not an enterprise gateway.
- **Beside Agent Ready, Store Sync and ACP in ChatGPT.** Those are where a merchant takes an agent's payment, and they need onboarding. Praman sits before them, on the buyer's side: it decides whether the agent may place the order at all.

## 7. Sources

Read on 9 Nov 2026. Web pages change, so check the page before relying on a quotation.

AP2:

- Home page, with the three questions and the v0.2 notice: <https://ap2-protocol.org/>
- Specification, with roles and the two modes: <https://ap2-protocol.org/ap2/specification/>
- Payment Mandate, with the constraint types: <https://ap2-protocol.org/ap2/payment_mandate/>
- Checkout Mandate: <https://ap2-protocol.org/ap2/checkout_mandate/>
- Agent authorization, with key binding, receipts and the unknown-constraint rule: <https://ap2-protocol.org/ap2/agent_authorization/>

ACP:

- Delegated payment spec, with the allowance: <https://developers.openai.com/commerce/specs/payment.md>
- PayPal's ACP integration guide, updated 29 Oct 2026: <https://developer.paypal.com/agent-ready/agentic-commerce-protocol>

PayPal:

- AP2 post, 16 Sep 2025: <https://developer.paypal.com/community/blog/PayPal-Agent-Payments-Protocol/>
- MCP Gateway post, 8 Oct 2026: <https://developer.paypal.com/community/blog/PayPal_MCP_Gateway>
- WebMCP post, 16 Sep 2026: <https://developer.paypal.com/community/blog/WebMCP_PayPal_Agent_Ready>
- Newsroom, January 2026: <https://newsroom.paypal-corp.com/2026-01-22-Making-Sense-of-the-AI-Shopping-Protocol-Moment>
- Newsroom on ACP, 28 Oct 2025: <https://newsroom.paypal-corp.com/2025-10-28-OpenAI-and-PayPal-Team-Up-to-Power-Instant-Checkout-and-Agentic-Commerce-in-ChatGPT>
- Agent Toolkit: <https://developer.paypal.com/ai-tools/toolkit/> and <https://github.com/paypal/agent-toolkit>
- Agent tools reference: <https://developer.paypal.com/ai-tools/agent-tools/>
- MCP server: <https://developer.paypal.com/ai-tools/mcp-server/>

Google Cloud:

- PayPal and Google Cloud merchant solution, 28 Oct 2025: <https://cloud.google.com/blog/topics/financial-services/introducing-an-agentic-commerce-solution-for-merchants-from-paypal-and-google-cloud>
