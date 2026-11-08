# Devpost submission text

Paste each section into its Devpost field. The sandbox login goes in the two marked places in Testing instructions, and only on Devpost. It is never committed here.

## Tagline

An AI agent can be talked into spending. Praman makes sure talking is all it can do.

## What it does

Praman is a control plane for AI agents that pay with PayPal. The agent can only propose a purchase, as a SKU and a quantity. There is no price field for it to fill in. Praman takes the price from the catalog, checks the cart against limits a person signed, and only then calls PayPal.

Every proposal gets one of three answers from a pure function with no model inside it:

- **ALLOW:** the payment runs.
- **STEP_UP:** a person approves, and the check runs again.
- **DENY:** a code from a closed list of 21 says why, and nothing reaches PayPal.

Every intent, decision, API call and outcome goes on an append-only, hash-chained ledger. Spend is replayed from that ledger, never stored in a column someone could edit.

The hosted demo walks through eight steps on the PayPal sandbox with a live model:

1. A signed mandate: $60 budget, nothing over $40, approval at $20 or more and for the first purchase at any shop.
2. PayPal account saved through the Vault API.
3. A $12.50 first purchase, held for approval, then charged with no buyer at PayPal.
4. A $4.50 coffee the agent buys on its own, inside the mandate.
5. A $32 lunch that needs approval and a real PayPal checkout, with the mandate checked again before capture.
6. A shop listing that tells the agent to add a gift card. The cart from a fooled model is refused with `CATEGORY_OUT_OF_SCOPE`.
7. Twenty test purchases at once against a $30 budget, on a simulated rail with no model: 5 paid, 15 refused.
8. Revoking the mandate. The agent's next try is refused with `MANDATE_REVOKED`.

## Who it is for and why it matters

**Merchants and platforms that let agents pay** get one place where each agent purchase is decided before PayPal is called, and a record they can hand over in a dispute.

**People who give an agent spending authority** sign their limits once. The agent never sees them and can't change them.

An agentic checkout reads text an attacker can write, a product description, and then calls a payment API. Prompt defences lower the odds and can't remove them. Praman takes the model out of the authorisation decision, so a manipulated model can want the wrong thing and still can't charge it. When something does go wrong, the ledger answers what happened, why it was allowed and what can be proved.

We saw this in our own eval. In a recorded run with defences removed, the model was fooled 2 times out of 21 and wrote that the injected item was required. The policy refused both. Two cases show the mechanism working. They aren't a rate, and the report says so.

## How we built it

- **Language and storage:** TypeScript in strict mode, a pnpm monorepo, Postgres with Prisma. Amounts are integer minor units typed `bigint`, with the currency taken from the signed mandate.
- **Mandates:** Ed25519 signatures over canonical JSON.
- **Policy:** `evaluate()` is a single pure function of intent, mandate, ledger state, catalog and time. No I/O, no clock, no randomness and no model.
- **Payment execution:** two phases, because a database transaction and an API call can't be made atomic. T1 evaluates and commits a pending outbox record. The PayPal call happens outside any transaction. T2 appends the outcome. A sweep settles anything left unknown.
- **Ledger:** Postgres triggers refuse UPDATE and DELETE. Hashes chain every row to the one before.
- **Agent:** a provider-neutral model interface, with Gemini on the hosted demo. Merchant text is wrapped as untrusted before it enters a prompt.
- **MCP gateway:** a local MCP server, so any MCP client can shop within one signed mandate.
- **Testing:** 1027 automated tests, a 46-case policy eval that runs in CI, a live-model eval run by hand, and Playwright against both a local stand-in and the hosted site.

### PayPal APIs used

- **Orders v2:** create, read, and capture after buyer approval (`/v2/checkout/orders`).
- **Vault v3:** setup tokens and payment tokens, to charge a saved account with no buyer present and delete it when the session ends (`/v3/vault/setup-tokens`, `/v3/vault/payment-tokens`).
- **Payments v2:** read a capture and issue a full refund (`/v2/payments/captures/{id}`, `/refund`).
- **Webhooks:** each delivery is checked with `/v1/notifications/verify-webhook-signature` against the exact bytes delivered.

We call the REST APIs directly and don't use the PayPal Agent Toolkit. The toolkit gives a model tools that act on PayPal, and Praman exists to decide whether that action should happen.

### Render

The demo runs on a Render web service, defined in `render.yaml` as a Blueprint on the free plan and deployed automatically from the branch. Render's health check uses `/healthz`. The reconcile and release sweeps run inside the web process. Postgres is on Neon.

We measured Render's real proxy chain instead of guessing it. The per-address rate limit was reading a proxy's entry instead of the visitor's. `TRUST_PROXY=3` came from that measurement (decision D-78).

### AG Grid

The ledger console at `/demo/console` uses AG Grid Community 36.2.0 and AG Charts Community 14.2.0, pinned and served from the app itself.

- The grid shows one row per ledger entry, with search across every column and a filter and sort on each.
- Each row carries a server-side hash check. Selecting a row shows stored and recomputed hashes side by side.
- The charts show spend against budget, decisions by reason code, and outcomes by rail. Selecting a bar filters the grid.

### Channel3

`pnpm catalog:channel3` takes 18 real products from Channel3's product search and pins each price in integer cents, with the source and fetch time. The MCP gateway sells from that snapshot. Decisions use the stored price and nothing is fetched at decision time. This runs locally through the gateway and isn't part of the hosted web demo. Paying the demo shop pays our PayPal sandbox account, not the retailer.

## Significant updates since 1 October 2026

Praman began at the Razorpay AI Buildathon, which ended on 5 September 2026 (tag `v1.0-submission`). The project had one rail, Razorpay test mode, and rupees only. Everything below came after 1 October, across more than 250 commits.

- PayPal as a second rail, in USD, with currency taken from the signed mandate
- Capture with a mandate re-check, and release of checkouts nobody paid
- Saved-account charges with no buyer present, through Vault v3
- Verified PayPal webhooks that settle payments
- Full refunds through the same two-phase outbox, which never give budget back
- The eight-step public demo, hosted on Render, with per-address, per-session and per-day limits
- The AG Grid and AG Charts ledger console
- The MCP gateway with the Channel3 catalog
- Dispute bundles: a public copy with limits withheld and a full copy for the owner
- The policy eval run on both rails

Compare: <https://github.com/Adwaith-R-Nair/Praman/compare/51012ef...paypal-hackathon>

## What we verified on the hosted site

On 8 November 2026 the full demo ran on <https://praman-demo.onrender.com> with a real sandbox buyer.

- $12.50 and $4.50 from the saved account and $32.00 at checkout. PayPal shows each as COMPLETED with one capture.
- A real `PAYMENT.CAPTURE.COMPLETED` webhook arrived and its signature verified.
- Two refunds went through, and the mandate still counts $49.00 spent, because a refund gives no budget back.
- Twenty test purchases at once, on a simulated rail: 5 paid, 15 refused, exactly $30.00.

## Challenges

**Razorpay doesn't enforce receipt uniqueness, despite documenting it.** Two orders with the same receipt came back as two orders. That ended our plan to rely on one transaction and led to the two-phase outbox.

**Twenty concurrent intents once created 4 times a mandate's budget.** Attempts in flight weren't counted. Now they hold budget until the sweep settles them (decision D-42).

**The refusals leaked the limits.** Error details quoted the exact cap. We split internal decisions from what the agent is told. Redaction only slows probing, so a denial-rate cap covers the rest (D-19, D-20). The same concern later reached the public dispute bundle, which now withholds limits (D-84).

**Missing data read as permission.** `new Date("garbage")` gives `NaN`, and every comparison against it is false, so a malformed validity window would have read as always valid.

## Honest limits

- Sandbox and test mode only.
- The 100% policy containment result (17 of 17 on the dev split, 11 of 11 held out) shows the code matches its specification. The same author wrote both, so it is weak evidence against attacks nobody anticipated.
- Not yet run on the hosted site: the 11-minute release of an unpaid checkout, and an MCP gateway checkout paid by a real buyer.
- `TRUNCATE` bypasses the ledger's triggers, and Merkle roots aren't anchored externally.
- Refunds are full only, and refunds made in PayPal's dashboard don't reach the ledger.

The repo's README, `docs/DECISIONS.md` and `docs/BUILD_LOG.md` record the rest.

## Built with

TypeScript, Node.js, Postgres, Prisma, PayPal REST APIs, Render, Neon, AG Grid, AG Charts, Channel3, Model Context Protocol, Gemini, Playwright, Vitest

## Links

- Hosted demo: <https://praman-demo.onrender.com>
- Code: <https://github.com/Adwaith-R-Nair/Praman>
- Video: `<paste the YouTube link here>`

## Testing instructions

Open <https://praman-demo.onrender.com> and press **Try the live demo**. The free host can take up to a minute to wake. No real money moves. The demo allows 5 new sessions per address every 10 minutes.

**Sandbox buyer (US Personal account):**

- Email: `<paste the US Personal sandbox email here>`
- Password: `<paste the sandbox password here>`

Use a window that isn't logged in to PayPal for the checkout in step 5. Open the demo in a normal window and the checkout in a private one. If the demo is in a private window, use another browser for the checkout.

1. Press **Start a session**. You get a signed mandate.
2. Press **Connect PayPal**, log in as the sandbox buyer and agree to save the account.
3. Press **Ask the agent to buy lunch**, then **Approve this purchase**. The saved account is charged.
4. Press **Ask the agent to buy a coffee**. Praman allows it with no approval.
5. Press **Ask the agent to buy a team lunch** and approve. Copy the checkout link to a private window, log in, pay, return and press **Capture the payment**.
6. Read **A poisoned listing**: the live model's answer, then a simulated fooled cart, labelled as one, which is refused.
7. Run **Twenty purchases at once**: 5 are paid and the rest refused.
8. Press **Revoke the mandate**, then **Ask the agent to buy a coffee**. It is refused with `MANDATE_REVOKED`. Do this last.

Each step links to its **Ledger trace**, with **Verify this chain**, and its **Dispute bundle**. **Open your ledger console** at the top of the page shows your session's rows in the grid.

If PayPal declines a checkout, close every private window and open the link in a fresh one. A checkout left unpaid for 10 minutes is released, and nothing is charged. To run it locally, follow the Quickstart in the README.
