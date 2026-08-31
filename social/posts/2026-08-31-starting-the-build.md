# Post options — starting the build

Context: first public post about Praman (control plane for agent-initiated payments, Razorpay AI Buildathon 2026 Track 01). Covers work shipped so far: strict TS/pnpm setup, branded Paise/bigint type, hardened JSON parsing, canonical JSON serialiser, and policy engine groundwork (SKU aggregation, redacted mandate limits, currency validation, property-based tests). Ledger, execution layer, and eval corpus are not built yet.

All char counts verified against the 280 free-tier limit.

---

## Option 1 — single tweet, stance-led (255 chars)

> An LLM should never get to say yes to a payment. That's the rule this whole project is built around. The model proposes a purchase, a small deterministic policy engine decides, never the model itself. No floats anywhere near the money, only integer paise.

Pairs well with: a screenshot of the `evaluate()` function signature (not the body) or the CLAUDE.md invariant list, blurred/cropped to just the headline rule.

---

## Option 2 — single tweet, "the boring stuff that matters" (255 chars)

> This week: bigint paise instead of floats, a JSON parser hardened against BigInt coercion silently mangling amounts, and mandate limits redacted from what the agent itself sees in a decision. Building the control plane for AI agents that spend real money.

Pairs well with: a terminal screenshot of the passing test suite, or a before/after of the JSON coercion bug being caught by a test.

---

## Option 3 — thread, 4 tweets (project intro + rule + type safety + what's next)

**1/4** (181 chars)
> Giving an AI agent a Razorpay account this month. Not because it's easy, because almost everything about it can go wrong quietly. Starting a thread on what I'm building and why. 1/4

**2/4** (212 chars)
> The core rule: the model never authorizes money movement. It produces a purchase intent, a plain policy engine evaluates it, and only that engine's decision is final. No LLM call anywhere near the money path. 2/4

**3/4** (211 chars)
> Money is integer paise, typed bigint, everywhere. No floats, no Number arithmetic on amounts, no parsing currency out of model output. The price always comes from the catalog, never from what the agent says. 3/4

**4/4** (203 chars)
> Next up: an append only ledger and the actual Razorpay execution layer, plus a corpus of adversarial prompts to throw at the policy engine before I trust it with anything. Following along, more soon. 4/4

Pairs well with: a short screen recording scrolling through the repo structure (packages/policy, packages/shared) on tweet 1, and a terminal running the test suite on tweet 3.

---

## Option 4 — single tweet, question-led hook (273 chars)

> What breaks first when you let an AI agent spend money on its own. That's the question this project is trying to answer, on purpose, in a sandbox, before anyone lets this happen for real. First pieces: typed amounts, a policy engine, and a paper trail that can't be edited.

Pairs well with: nothing required, works as text-only, but a screenshot of the roadmap doc works if you want visual weight.

---

## Recommendation

Option 3 (the thread) carries the most information without crowding any single tweet, and gives you a natural place to reply with updates as later phases ship. Option 1 or 4 work well as a standalone if you'd rather start smaller and save the fuller story for a follow-up thread once the ledger and execution layer land.
