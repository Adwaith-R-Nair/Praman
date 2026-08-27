# Praman — Roadmap

Eight phases across nine days. Each phase has an **exit criterion** that is demoable and an **understanding gate** you must pass before advancing.

The rule: *if you cannot explain the phase you just finished without looking at the code, you do not start the next one.* That rule is the difference between a project you built and a project that happened near you.

---

## Phase 0 — Foundation · Day 0 (Wed 27 Aug)

Repo, spec, keys, rails.

**Exit:** public repo with docs committed; Razorpay test keys work; one manual test-mode payment completed via dashboard.
**Gate:** you can explain what a Razorpay order is, what a payment is, and why capture is a separate step.

## Phase 1 — The decision core · Day 1 (Thu 28 Aug)

Workspace scaffold, shared types, `evaluate()` hand-written, full unit + property tests.

**Exit:** `pnpm test` green; every one of the 17 reason codes has a test.
**Gate:** whiteboard the 15-step evaluation order from memory, and explain why step 9 (amount resolution) comes after step 7 (category check).

## Phase 2 — The ledger · Day 2 (Fri 29 Aug)

Postgres, Prisma, hash chain, immutability rules, `deriveState`, `verify-ledger` CLI, Merkle checkpoints.

**Exit:** tamper a row via raw SQL, `pnpm verify-ledger` exits non-zero and names the broken sequence number.
**Gate:** explain why field separators are in the hash preimage, and why the mandate has no `spent_paise` column.

## Phase 3 — Control plane + execution · Day 3 (Sat 30 Aug)

Express API, Ed25519 mandate issuance and verification, `razorpay-exec`, idempotency, advisory lock, one transaction end to end.

**Exit:** signed mandate → intent → ALLOW → real test-mode payment → complete ledger trace. Screen-record it as insurance.
**Gate:** explain what happens if two identical intents arrive in the same millisecond, and why you chose an advisory lock over SERIALIZABLE.

## Phase 4 — Agent + merchant · Day 4 (Sun 31 Aug)

MCP catalog server, seeded catalog, Claude buyer agent with tool use, `wrapUntrusted` at the agent boundary, turn cap.

**Exit:** `pnpm demo "order lunch for two under ₹700"` completes end to end from one command.
**Gate:** explain why sanitisation lives in the agent and not the MCP server, and why the agent isn't told its budget.

## Phase 5 — Gates and failure paths · Day 5 (Mon 1 Sep)

Step-up approval flow, forced payment failure, single retry, escalation, first three injection fixtures.

**Exit:** all three demo beats work — allow, block, escalate.
**Gate:** walk the full step-up lifecycle including what's in the ledger at each stage.

## Phase 6 — Measurement · Day 6 (Tue 2 Sep)

Benign corpus (40) → runner → adversarial corpus (60) → **commit the held-out split** → metrics → CI → README badge.

**Exit:** `pnpm eval` produces `report.md` and `report.json`; GitHub Actions green; badge live.
**Gate:** state your dev containment rate, your held-out containment rate, your false-refusal rate, and what's in the gap. Out loud, from memory.

## Phase 7 — Surface and story · Day 7 (Wed 3 Sep)

Receipt UI, dispute bundle (P2, first to cut), README, rendered diagrams, limitations section.

**Exit:** clean clone + follow your own README = working demo.
**Gate:** give the 5-minute pitch to a wall, timed, without notes.

## Phase 8 — Held-out run and submission · Days 8–9 (Thu 4 – Fri 5 Sep)

Final held-out run, honest exception list, record the video, clean-clone verification, submit Friday morning.

**Exit:** submitted, repo untouched afterwards.

---

## Milestones

| # | Milestone | By end of |
|---|---|---|
| M1 | A decision can be made and defended | Phase 1 |
| M2 | History cannot be forged undetectably | Phase 2 |
| M3 | Money moves through the gate | Phase 3 |
| M4 | An agent drives it end to end | Phase 4 |
| M5 | It fails safely | Phase 5 |
| M6 | It has honest numbers | Phase 6 |
| M7 | A stranger can run and understand it | Phase 7 |
| M8 | Submitted | Phase 8 |

**M2, M3 and M6 are the load-bearing ones.** If a day slips, protect those.

---

## Cut list, in order

1. Dispute evidence bundle
2. Receipt UI → JSON endpoint plus a plain HTML dump
3. Merchant MCP → plain REST catalog
4. Benign families `unusual_but_valid` and `legitimate_retry` → shrink to 25 benign cases
5. Merkle checkpoints → keep the chain, drop the roots

**Never cut:** policy engine, hash-chained ledger, eval harness, held-out split, honest exception list.

Every cut goes in the README's limitations section. A documented cut is engineering judgement; an undocumented one is a hole.

---

## Post-submission roadmap (put this in the README — it shows you know where this goes)

- **Near term:** external anchoring of Merkle checkpoints; mandate delegation chains; multi-merchant scope with per-merchant sub-budgets.
- **Medium:** adapter layer so the same policy core sits behind UAP, AP2, or ACP once specifications are public; webhook-driven settlement reconciliation.
- **Longer:** policy-as-code so a merchant can express its own agent rules; a shared refusal-reason vocabulary so agents across providers can interpret denials without prose parsing.