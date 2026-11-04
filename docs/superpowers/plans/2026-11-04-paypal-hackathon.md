# Praman for the PayPal AI Hackathon: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add PayPal as a second governed payment rail with INR and USD support, and ship a hosted demo and submission by 2026-11-13 01:30 IST.

**Architecture:** One integer amount plus a currency from the signed mandate. A rail-neutral `Executor` behind `packages/exec-core`, with `razorpay-exec` and `paypal-exec` as implementations. The rail comes from server-side merchant configuration. `packages/policy` freezes before PayPal lands, and CI proves it stayed frozen.

**Tech Stack:** TypeScript strict, pnpm workspaces, Vitest, Postgres 17, Prisma 7, node:http server-rendered UI, PayPal Orders v2 REST, Render.

**Spec:** `docs/superpowers/specs/2026-11-04-paypal-hackathon-design.md`

**Baseline at plan time:** commit `3394f5c`, 160 tests in 21 files passing, typecheck clean, PayPal keys not yet in `.env`.

## Global Constraints

- All amounts are integer minor units, typed `bigint`, field names suffixed `_minor`. No floats and no `Number` arithmetic on amounts.
- Currency is `"INR" | "USD"` and comes only from the signed mandate. Never region. No FX conversion.
- Prices come from the catalog. The rail comes from merchant configuration. Neither ever comes from model output.
- No LLM, Langfuse or OpenTelemetry import in `packages/policy`, `packages/ledger`, `packages/exec-core`, `packages/razorpay-exec` or `packages/paypal-exec`.
- Idempotency keys are derived, never random and never caller-supplied.
- The ledger stays append-only. Old rows are never rewritten. Readers accept both `amount_paise` and `amount_minor` permanently.
- Reason codes stay a closed enum. A new code goes in the enum, `docs/MANDATE_SPEC.md` §4, `apps/receipt-ui/src/reason-codes.ts` and the eval corpus. `pnpm eval:check-coverage` enforces the corpus part.
- Merchant, PayPal API and webhook text is untrusted: wrapped before any prompt, HTML-escaped before any page.
- Injection material comes from the static corpus only. Nothing generates attack text.
- Sandbox and test-mode keys only. Secrets come from `.env`, with empty names in `.env.example`.
- Anything simulated or recorded is labelled on screen.
- Results are typed, not thrown, on the money path. No `any`. No `as` casts on the money path.
- Commits: one logical change, conventional prefix, subject under 72 characters, explicit paths staged, no trailers.
- **Every task ends with docs.** Add a `docs/BUILD_LOG.md` entry headed `### Phase P<task> · <date> · <topic>` under a new `## PayPal Hackathon` divider, written so the builder can follow what changed and why. Add a `docs/DECISIONS.md` record, numbered from the next free number, for each real design choice. Existing entries are never edited. Superseded records only gain a `Status:` pointer.
- Done means `pnpm test`, `pnpm typecheck`, `pnpm lint:boundary`, `pnpm eval:check-coverage` and `pnpm --filter @praman/shared run lint:casts` all pass.

## Review Focus

1. A buyer double-clicks approve, or the capture request is retried: exactly one capture, one ledger outcome, budget counted once. Test in Task 7.
2. A visitor closes checkout and returns after the 10-minute release: capture refused with `ORDER_RELEASED`, and the page explains it in plain words rather than a 500. Tests in Tasks 7 and 12.
3. A webhook arrives before T2, arrives twice, or has a forged signature: correct final state, one settlement, nothing appended when forged. Test in Task 9.
4. A corpus fixture containing HTML or script is shown on the demo page: rendered as inert text. Test in Task 12.
5. The model quota runs out or PayPal sandbox is down during judging: a labelled recording or plain message, no money state left ambiguous, no stack trace on screen. Test in Task 13.

---

### Task 0: Sandbox spike, outside the repo

Blocked until the builder adds `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` to `.env`. Tasks 1 to 5 do not depend on this and can proceed first.

**Files:**
- Create: scratchpad scripts only, nothing in the repo
- Modify: `docs/DECISIONS.md`, `docs/BUILD_LOG.md`, `.env.example`

- [ ] **Step 1:** Write throwaway scripts that answer spec questions 1 to 10, loading `.env` without printing values.
- [ ] **Step 2:** For the webhook question, install `cloudflared` as a temporary tunnel and save real sandbox deliveries, with secrets stripped.
- [ ] **Step 3:** Record each answer with the observed response in a decision record titled "What PayPal's sandbox actually guarantees", in the style of D-22. Include the chosen reconciliation candidate, and whether vault capture works.
- [ ] **Step 4:** If the sandbox does not work from the builder's account, stop and report. Add the two names to `.env.example`.
- [ ] **Step 5:** Commit `docs: record what paypal sandbox actually guarantees`.

### Task 1: Tell the true story in the docs

**Files:**
- Modify: `docs/INVARIANTS.md` (items 2, 3), `README.md:9,42,209`, `docs/ARCHITECTURE.md:40,107`, `docs/LLD.md:214`, `docs/PRD.md:97`, `docs/DECISIONS.md`, `docs/BUILD_LOG.md`
- Add: `docs/ROADMAP_PHASE2.md` one status note, pointing to the design

- [ ] **Step 1:** Add a decision record "Moving to an agentic development life cycle": `evaluate.ts` and the hash chain were hand-written up to `v1.0-submission`, and changes after that are agent-written and reviewed by the builder, each with a failing test first and its own commit.
- [ ] **Step 2:** Reword the listed lines as history. `git grep -nEi "hand-?(written|authored)" -- README.md docs` must show no present-tense claim outside dated records.
- [ ] **Step 3:** Add a README "History" section: Razorpay Buildathon, independent learning, PayPal AI Hackathon, continuing after it. Include comparison links for `v1.0-submission...main` and `51012ef...main`.
- [ ] **Step 4:** Commit `docs: describe the project history and the move to adlc`.

### Task 2: Rename paise to minor units, with no behaviour change

Touches about 320 lines in 52 files, because the name is everywhere. Mechanical and isolated so a reviewer can check it as one thing.

**Files:**
- Modify: `packages/shared/src/money.ts`, `ledger-state.ts`, and all `_paise`/`Paise` users, including `packages/policy/src/evaluate.ts`
- Create: `packages/db/prisma/migrations/<ts>_rename_amount_columns/migration.sql`
- Test: `packages/ledger/test/derive.test.ts`, `packages/mandate/test/sign.test.ts`, `packages/ledger/test/verify.test.ts`

**Interfaces:**
- Produces in `@praman/shared`: `Minor`, `minor(v)`, `ZERO_MINOR`, `addMinor`, `subMinor`, `mulMinor`, `minorToJSON`, `minorFromJSON`, `minorFromDb`, `minorFromRazorpay`. `LedgerDerivedState.spent_minor`.
- Produces in `@praman/policy`: `max_per_txn_minor`, `max_total_minor`, `threshold_minor`, `price_minor`, `amount_minor`, `remaining_minor`.
- Produces in `@praman/mandate`: `MandateDocument = MandateDocumentV1 | MandateDocumentV2`. V1 keeps `_paise` names and verifies over its original bytes. V2 uses `_minor`.

- [ ] **Step 1: Write failing tests**

```ts
it("verifies a v1 mandate signed before the rename, hydrated to minor units")
// sign a literal v1 document; verifyMandate(...).mandate.limits.max_total_minor === 500000n

it("derives spend from old amount_paise and new amount_minor outcomes")
// one outcome of each shape: state.spent_minor === sum

it("rejects an outcome with neither amount field")

it("verifyChain still passes on rows written before the migration")
```

- [ ] **Step 2:** Run `pnpm vitest run packages/ledger packages/mandate`. Expected: FAIL.
- [ ] **Step 3:** Rename across code, Prisma fields and columns. New ledger payloads write `amount_minor`. Add `readAmount(payload, seq)` in `packages/ledger/src/derive.ts`, used by `dispute` and `receipt-ui` too. Convert eval fixtures to v2 and keep one v1 fixture as a regression case. Update the `lint:casts` pattern in `packages/shared/package.json` to `as Minor`.
- [ ] **Step 4:** Run the full done-check. Expected: all pass, and `grep -r "_paise" packages apps --include='*.ts'` matches only the v1 type, `readAmount` and tests.
- [ ] **Step 5:** Run `pnpm verify-ledger` against the dev database after migrating. Expected: passes.
- [ ] **Step 6:** Update `docs/MANDATE_SPEC.md`, `docs/LLD.md` names, add a decision record on schema evolution under immutability, and log it. Commit `refactor: rename paise amounts to currency-neutral minor units`.

### Task 3: Currency from the signed mandate, and the mismatch check

**Files:**
- Modify: `packages/shared/src/money.ts`, `packages/shared/src/reason-codes.ts`, `packages/policy/src/types.ts`, `packages/policy/src/evaluate.ts`, `packages/mandate/src/sign.ts`, `packages/db/prisma/schema.prisma`, `packages/db/src/catalog.ts`, `scripts/seed-catalog.ts`, `scripts/issue-mandate.ts`, `apps/eval/corpus/layer1.json`, `apps/receipt-ui/src/reason-codes.ts`, `docs/MANDATE_SPEC.md`
- Create: a migration adding `catalog_item.currency` (default `'INR'` for existing rows) and table `merchant`
- Test: `packages/policy/test/evaluate.test.ts`, `packages/shared/test/*`, `packages/mandate/test/sign.test.ts`

**Interfaces:**
- Produces: `type Currency = "INR" | "USD"`, `CURRENCIES`, `formatMoney(v: Minor, c: Currency): string`, reason code `CURRENCY_MISMATCH`, `CatalogItem.currency`, `VerifiedMandate.scope.currency: Currency`.
- Produces: Prisma `Merchant { merchantId, rail: "razorpay" | "paypal" | "simulated", currency }`, and `loadMerchantConfig(tx, merchantId)` in `@praman/db`.

- [ ] **Step 1: Write failing tests**

```ts
it("allows a USD mandate buying a USD item", ...)            // kind !== "DENY", amount exact
it("denies a USD mandate buying an INR item", ...)           // reason_code "CURRENCY_MISMATCH"
it("denies an INR mandate buying a USD item", ...)           // reason_code "CURRENCY_MISMATCH"
it("still denies an unsupported mandate currency", ...)      // "JPY" => AMOUNT_INVALID
it("reports the mismatch deterministically across cart order", ...)
it("v1 mandates normalise to INR", ...)
it("formatMoney renders 50000n INR as ₹500.00 and 1250n USD as $12.50", ...)
```

- [ ] **Step 2:** Run `pnpm vitest run packages/policy packages/shared packages/mandate`. Expected: FAIL.
- [ ] **Step 3:** In `evaluate.ts`, step 5b checks membership in `CURRENCIES`. Inside the sorted SKU loop, right after `SKU_UNKNOWN`, deny `CURRENCY_MISMATCH` when `catalogItem.currency !== mandate.scope.currency`.
- [ ] **Step 4:** Update the seeding scripts, and add Layer 1 fixtures for USD allow, both mismatch directions and the unsupported currency.
- [ ] **Step 5:** Run the full done-check. Expected: pass.
- [ ] **Step 6:** Decision record "Currency comes from the signed mandate". Log it. Commit `feat: support usd and deny currency mismatch against the mandate`.

### Task 4: Spend semantics, capture re-check, and freezing policy

**Files:**
- Create: `packages/policy/src/evaluate-capture.ts`, `scripts/check-policy-freeze.ts`, `.policy-freeze`
- Modify: `packages/ledger/src/derive.ts`, `packages/ledger/src/append.ts`, `packages/shared/src/reason-codes.ts`, `packages/shared/src/ledger-state.ts`, `.github/workflows/ci.yml`, `package.json`, `docs/DECISIONS.md` (D-17 `Status:` pointer)
- Test: `packages/policy/test/evaluate-capture.test.ts`, `packages/ledger/test/derive.test.ts`

**Interfaces:**
- Produces in `@praman/policy`:

```ts
export interface CaptureInput {
  readonly mandate: VerifiedMandate;
  readonly state: LedgerDerivedState;
  readonly now: Date;
  readonly order: {
    readonly idempotency_key: string;
    readonly held_amount_minor: Minor;  // from the ledger
    readonly quoted_amount_minor: Minor; // from the rail
    readonly currency: Currency;
  };
}
export type CaptureDecision =
  | { readonly kind: "ALLOW_CAPTURE"; readonly amount_minor: Minor; readonly reason_code: "OK" }
  | { readonly kind: "DENY"; readonly reason_code: DenyCode; readonly detail: string };
export function evaluateCapture(input: CaptureInput): CaptureDecision;
```

- Produces: reason code `ORDER_RELEASED`, an addition to the spec's "existing codes" because no existing code means this and the caller must do something different. `LedgerDerivedState.released_keys: ReadonlySet<string>`. New event types `capture_decision` and `settlement`. Outcome status `released`. `capture_decision` denials do not count toward `denied_attempts`.

- [ ] **Step 1: Write failing tests**

```ts
// evaluate-capture.test.ts
it("allows capture on a live mandate with matching amounts")
it("denies MANDATE_REVOKED when revoked during checkout")
it("denies MANDATE_EXPIRED when expired during checkout")
it("denies ORDER_RELEASED when the key was released")
it("denies AMOUNT_CHANGED_SINCE_APPROVAL when rail amount differs from the hold")
it("denies CURRENCY_MISMATCH when the order currency differs from the mandate")
it("is pure: same input deep-equals same output")

// derive.test.ts
it("counts created then captured with one key once")
it("released frees budget but keeps the velocity timestamp")
it("a released order does not count as a merchant transacted")
it("a capture_decision denial is not a denied attempt")
it("old outcomes with no idempotency key still count individually")
```

- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. `deriveState` folds outcomes into a map by `idempotency_key`, applying `released` last, and adds a merchant only for keys not released. Razorpay `created` orders behave exactly as before, so D-17 holds for that rail.
- [ ] **Step 4:** Add Layer 1 fixtures and update the enum locations for `ORDER_RELEASED`.
- [ ] **Step 5:** Write `scripts/check-policy-freeze.ts`: it reads the SHA in `.policy-freeze` and fails if `git diff --quiet <sha> HEAD -- packages/policy` reports changes, printing the changed files. Add `pnpm lint:policy-freeze` and a CI step, with `fetch-depth: 0` on checkout. Prove it fails on a throwaway edit, then revert.
- [ ] **Step 6:** Run the full done-check. Decision records "Budget during checkout" and "Capture re-checks the mandate". Commit `feat: hold budget per order and re-check the mandate at capture`.
- [ ] **Step 7:** After that commit lands, write its SHA to `.policy-freeze`. Commit `ci: freeze the policy package before adding the paypal rail`.

### Task 5: Rail-neutral executor

**Files:**
- Create: `packages/exec-core/` (`package.json`, `src/executor.ts`, `src/idempotency.ts`, `src/simulated.ts`, `src/index.ts`)
- Modify: `packages/razorpay-exec/src/*`, `packages/control-plane/src/run-intent.ts`, `resolve-approval.ts`, `reconcile.ts`, `apps/buyer-agent/src/demo.ts`, `scripts/approve.ts`, `apps/eval/src/runner.ts`, `scripts/check-import-boundary.ts`, `packages/db/prisma/schema.prisma`
- Create: migration adding `idempotency_record.rail` (default `'razorpay'`) and `currency`
- Test: `packages/exec-core/test/*`, `packages/control-plane/test/run-intent.test.ts`

**Interfaces:**

```ts
export type Rail = "razorpay" | "paypal" | "simulated";
export interface ExecOutcome {
  readonly rail: Rail;
  readonly order_id: string;
  readonly status: "created" | "captured" | "failed";
  readonly amount_minor: Minor;
  readonly currency: Currency;
  readonly payment_id: string | null;
  readonly approve_url: string | null;
  readonly failure_code: string | null;
}
export interface CreateOrderRequest { amount_minor: Minor; currency: Currency; idempotency_key: string; receipt: string; }
export interface OrderLookup { receipt: string; idempotency_key: string; order_id: string | null; amount_minor: Minor; currency: Currency; }
export interface CaptureRequest { order_id: string; amount_minor: Minor; currency: Currency; idempotency_key: string; }
export interface Executor {
  readonly rail: Rail;
  createOrder(req: CreateOrderRequest): Promise<ExecOutcome>;
  findOrder(lookup: OrderLookup): Promise<ExecOutcome | null>;
  capture(req: CaptureRequest): Promise<ExecOutcome>;
}
export type ExecutorRouter = (rail: Rail) => Executor | null;
export function routeAllTo(executor: Executor): ExecutorRouter; // test and eval convenience
```

`runIntent`, `resolveApproval` and `reconcilePending` take an `ExecutorRouter`. `RunResult` gains `approve_url`.

- [ ] **Step 1: Write failing tests**

```ts
it("routes to the rail configured for the merchant, ignoring the intent")
it("denies cleanly with no call when no executor exists for the merchant's rail")
it("records rail and currency on the api_call and outcome events")
it("rejects an executor outcome whose currency differs from the request")
```

- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Move the code, adapt `LiveExecutor` to pass the real currency (Razorpay stays INR-only and refuses USD with a typed failure), load merchant config in T1, and replace `provider: "razorpay"` in ledger payloads with the routed rail. `api_call` also gains `idempotency_key` and `merchant_id` (F14, needed by Task 8).
- [ ] **Step 4:** Add `packages/exec-core`, and later `packages/paypal-exec`, to `PROTECTED_DIRS` in the boundary check. Run the full done-check, plus `pnpm lint:policy-freeze`. Expected: pass, with no policy diff.
- [ ] **Step 5:** Decision record "Rail comes from merchant configuration". Log it. Commit `refactor: route executions through a rail-neutral executor`.

### Task 6: `paypal-exec`

Requires Task 0's answers.

**Files:**
- Create: `packages/paypal-exec/` (`src/money.ts`, `src/client.ts`, `src/executor.ts`, `src/webhook.ts`, `src/index.ts`, `package.json`)
- Test: `packages/paypal-exec/test/money.test.ts`, `executor.test.ts`, `live.test.ts`

**Interfaces:**
- Produces: `toPayPalValue(v: Minor): string`, `fromPayPalValue(s: unknown): Minor`, and `class PayPalExecutor implements Executor` built from `{ clientId, clientSecret, baseUrl, fetch }`.

- [ ] **Step 1: Write failing tests**

```ts
it("formats 1250n as 12.50 and 5n as 0.05 and 100n as 1.00")
it.each(["12.5", "12.500", "-1.00", "1e3", " 1.00", "", "1,000.00"])("rejects %s")
it("rejects non-string amounts from PayPal")
it("round-trips across a property sweep of bigint values")
it("sends the derived key as PayPal-Request-Id on create and capture")
it("sets intent CAPTURE, reference and invoice ids from the receipt, and a USD amount")
it("refreshes the OAuth token once on 401, then returns a typed failure")
it("surfaces a network error so the record stays pending, never as failed")
it("reports the amount and currency PayPal returned, even when they differ from the request")
it("returns approve_url from the payer-action or approve link")
it.runIf(process.env.PAYPAL_CLIENT_ID)("creates a real sandbox order")
```

**Changed by D-33:** this list used to say a create response with a different amount is treated as a failure. `paypal-exec` must not do that. A rail reports what it was told, and `acceptOutcome` in `packages/exec-core` decides, recording a `mismatch` that holds budget. Marking it `failed` in the rail brings back the budget hole D-33 closed.

- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement with an injected `fetch`. `findOrder` uses the method chosen in Task 0. Do not import the PayPal Agent Toolkit. Add a README line explaining why.
- [ ] **Step 4:** Run the full done-check plus `pnpm lint:policy-freeze`. Expected: pass.
- [ ] **Step 5:** Log it. Commit `feat: add a paypal orders rail with exact decimal conversion`.

### Task 7: Capture, release and the reconciler

**Files:**
- Create: `packages/control-plane/src/capture-order.ts`, `packages/control-plane/src/release-orders.ts`, `scripts/reconcile.ts`
- Modify: `packages/control-plane/src/reconcile.ts`, `src/index.ts`, `package.json`
- Test: `packages/control-plane/test/capture-order.test.ts`, `release-orders.test.ts`, `reconcile.test.ts`

**Interfaces:**

```ts
export const ORDER_HOLD_TTL_MS = 10 * 60 * 1000;
export function captureRecordKey(orderKey: string): string; // sha256("capture|" + orderKey), derived
export type CaptureResult =
  | { kind: "CAPTURED"; trace_id: string; order_id: string; payment_id: string | null }
  | { kind: "REFUSED"; trace_id: string; reason_code: DenyCode; detail: string }
  | { kind: "IN_FLIGHT"; trace_id: string; detail: string }
  | { kind: "NOT_FOUND"; detail: string };
export function captureOrder(traceId: string, signed: SignedMandate, publicKeyPem: string, route: ExecutorRouter, now: Date): Promise<CaptureResult>;
export function releaseStaleOrders(route: ExecutorRouter, now: Date): Promise<number>;
```

- [ ] **Step 1: Write failing tests**

```ts
it("captures once when called twice, one ledger outcome, budget counted once")
it("captures once under two concurrent calls")
it("refuses capture after revocation and moves no money")
it("refuses capture after expiry and moves no money")
it("refuses capture after release with ORDER_RELEASED")
it("refuses when the rail's amount differs from the hold")
it("releases an unapproved paypal order after 10 minutes")
it("does not release before 10 minutes")
it("never releases a razorpay order")
it("does not release while a capture record is pending")
it("leaves a capture with an unknown outcome pending, then reconciles it by order id")
it("a capture refusal is a capture_decision and does not count toward the denial cap")
```

- [ ] **Step 2:** Run them. Expected: FAIL.
**Added by D-33 and D-34:** refuse to capture an order whose outcome is `mismatch`, and write `order_id` on capture and release outcomes, since a key can hold two orders.

- [ ] **Step 3:** Implement with the same two-phase shape as `runIntent`: T1 under `MANDATE_LOCK_NS` runs `evaluateCapture`, writes the capture record and `api_call`. The rail call runs outside any transaction. T2 appends the outcome. `release` takes the same lock. Reconcile covers both record kinds, and `pnpm reconcile` runs one sweep of both functions.
- [ ] **Step 4:** Run the full done-check plus `pnpm lint:policy-freeze`. Expected: pass.
- [ ] **Step 5:** Log it, with the state at each stage so the builder can walk it. Commit `feat: capture paypal orders under a mandate re-check`.

### Task 8: Close the in-flight window (roadmap Phase 13)

**Files:**
- Modify: `packages/ledger/src/derive.ts`, `packages/control-plane/src/reconcile.ts`, `docs/DECISIONS.md` (D-22 `Status:` pointer), `README.md` known gaps
- Create: `packages/control-plane/test/concurrent-spend.test.ts`, `LatchedExecutor` in `packages/exec-core/src/simulated.ts`

**Interfaces:**
- Produces: `class LatchedExecutor implements Executor` with `release(): void`.

- [ ] **Step 1: Write the failing test and commit it failing**

```ts
it("20 concurrent intents never create more than the mandate's budget")
// assert: sum of created amounts <= max_total_minor; count <= max_txns_per_window
```

Commit `test: show concurrent intents overspend during the call window`.

- [ ] **Step 2: Write more tests**

```ts
it("an attempted call with no outcome reserves budget and velocity")
it("an attempted call does not count as a merchant transacted")
it("a failed outcome releases the reservation")
it("old api_call events with no key pair by trace_id")
```

- [ ] **Step 3:** Implement the reservation in `deriveState` and hold the mandate lock during reconcile. Follow `ROADMAP_PHASE2.md` Phase 13 item 2.
- [ ] **Step 4:** Run the full done-check. Expected: pass.
- [ ] **Step 5:** Decision record "Attempted calls reserve budget". Log it, then commit `fix: count unresolved call attempts as reserved spend`.

### Task 9: PayPal webhooks

**Files:**
- Create: `apps/receipt-ui/src/webhooks.ts`, `packages/control-plane/src/settlement.ts`, `packages/paypal-exec/test/fixtures/*.json` (real sandbox deliveries from Task 0, secrets stripped)
- Modify: `packages/paypal-exec/src/webhook.ts`, `apps/receipt-ui/src/server.ts`, `.env.example` (`PAYPAL_WEBHOOK_ID`)
- Test: `packages/control-plane/test/settlement.test.ts`, `apps/receipt-ui/test/webhooks.test.ts`

**Interfaces:**
- Produces: `verifyPayPalWebhook(rawBody: Buffer, headers, webhookId, deps): Promise<boolean>`, `applySettlement(event, now): Promise<"applied" | "duplicate" | "unmatched">`.

- [ ] **Step 1: Write failing tests**

```ts
it("rejects a forged signature and appends nothing")
it("verifies over the raw bytes before parsing")
it("appends one settlement for capture completed")
it("a duplicate delivery appends nothing")
it("a webhook before T2 ends in the correct state after T2")
it("a webhook naming a pending record resolves it")
it("an event for an unknown order is logged and appends nothing")
it("webhook text never reaches a prompt or unescaped HTML")
```

- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement, including a settlement line on the trace page. The sweep stays as the backstop.
- [ ] **Step 4:** Run the full done-check plus `pnpm lint:policy-freeze`. Expected: pass.
- [ ] **Step 5:** Decision record "Webhooks speed up reconciliation, the sweep stays". Log it. Commit `feat: settle paypal payments from verified webhooks`.

### Task 10: Finish Phase 10

**Files:** confirm what remains against `ROADMAP_PHASE2.md` Phase 10 first. Expected remaining:
- Modify: `apps/eval/src/metrics.ts`, report generator, `docs/DECISIONS.md` (Appendix A record), `README.md`, `docs/BUILD_LOG.md`
- Create: a test in `packages/agent-core/test/` for tracing inertness

- [ ] **Step 1: Write failing tests**

```ts
it("the eval report shows token spend computed from provider usage")
it("with no langfuse keys, the same ledger event types appear in the same order")
it("with an unreachable langfuse host, the same result, within the flush timeout")
```

- [ ] **Step 2:** Run them. Expected: FAIL unless already covered, in which case note that in the log.
- [ ] **Step 3:** Implement. Push deterministic scores if `3394f5c` did not. Add the README "Observability vs evidence" section.
- [ ] **Step 4:** Run the full done-check. Log Phase 10. Commit in the boundaries the roadmap lists.

### Task 11: Honest numbers

**Files:**
- Modify: `apps/eval/src/metrics.ts`, report generator, `apps/eval/corpus/layer1.json`, `README.md`, `eval/report.md` (regenerated)
- Test: `apps/eval/test/stats.test.ts`

**Interfaces:**
- Produces: `wilson95(k: number, n: number): { low: number; high: number }`, `fisherExactTwoSided(a, b, c, d): number`. Statistics on counts, not money, so `number` is fine.

- [ ] **Step 1: Write failing tests**

```ts
it("wilson95(0, 21).high is about 0.155")
it("fisherExactTwoSided(2, 19, 0, 21) is about 0.49")
it("the report prints n and an interval beside every rate")
```

- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Run the same Layer 1 cases against both rails on the simulated executor, with PayPal merchants in USD and Razorpay merchants in INR.
- [ ] **Step 4:** Regenerate the report with `pnpm eval --layer1`. If a case fails, report it and fix the cause, never the fixture. Make every README number match the report, and state p ≈ 0.49 plainly.
- [ ] **Step 5:** Log it. Commit `feat: report intervals and the ablation fisher test`.

### Task 12: The demo story

Use the frontend-design skill for the visual pass.

**Files:**
- Create: `apps/receipt-ui/src/pages/demo.ts`, `apps/receipt-ui/src/demo/session.ts`, `apps/receipt-ui/src/demo/story.ts`, `apps/receipt-ui/src/demo/seed.ts`, `apps/receipt-ui/src/demo/recorded/*.json`, a small `apps/receipt-ui/src/demo/client.js`
- Modify: `apps/receipt-ui/src/server.ts`, `style.css`, `html.ts`
- Test: `apps/receipt-ui/test/demo.test.ts`

**Interfaces:**
- Produces: `createDemoSession(now): Promise<DemoSession>`, issuing a per-session USD mandate signed with `DEMO_MANDATE_PRIVATE_KEY`, routes under `/demo/*`, with approvals and captures bound to the session cookie.

Story beats, from the spec: first purchase (step-up, approve, real sandbox checkout), second purchase (`ALLOW`), large purchase (step-up), injection (model resists, labelled fixture refused, labelled recording), concurrency (labelled test-harness intents on the simulated rail).

- [ ] **Step 1: Write failing tests**

```ts
it("a new session's first purchase returns STEP_UP_FIRST_MERCHANT")
it("after a completed purchase the same merchant returns ALLOW below the threshold")
it("one visitor cannot approve or capture another session's order")
it("the request body cannot set price, currency, rail, merchant or goal")
it("a fixture containing <script> renders as inert text")
it("the fixture and recording are visibly labelled")
it("capture after release shows the plain explanation, not an error page")
it("the concurrency beat creates no more than the budget and makes no model calls")
it("the page never shows mandate limits to the agent's view or a stack trace to the visitor")
```

- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Build the routes and story. The visitor picks steps, and there is no free-text goal and no public intent API.
- [ ] **Step 4:** Do the design pass. Then run it with the `run` skill and take screenshots at desktop and mobile widths, checking real sandbox checkout end to end.
- [ ] **Step 5:** Run the full done-check. Log it. Commit in logical pieces: routes, story, design.

### Task 13: Hosted and hardened

Render account setup, environment values and the PayPal webhook registration are the builder's, using a list this task produces.

**Files:**
- Create: `render.yaml`, `apps/receipt-ui/src/demo/limits.ts`, `docs/DEPLOY.md`
- Modify: `apps/receipt-ui/src/server.ts`, `.env.example` (`DEMO_MANDATE_PRIVATE_KEY`, `DEMO_MANDATE_PUBLIC_KEY`, `DEMO_DAILY_MODEL_CALLS`)
- Test: `apps/receipt-ui/test/limits.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
it("after the daily model cap the story serves a labelled recording")
it("a session over its rate limit gets a plain 429 page")
it("paypal being unreachable leaves records pending and shows a plain message")
it("the model provider failing shows a plain message and moves no money")
it("refuses to start with non-sandbox paypal or razorpay credentials or base urls")
it("refuses to start in demo mode with the local mandate key")
it("the sweep runs on an interval and one failure does not stop it")
```

- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Add security headers, escape all output, keep `/dispute` and `/verify` public but rate limited, and do not expose Langfuse links.
- [ ] **Step 4:** Write `render.yaml` and `docs/DEPLOY.md`. After the builder creates the service, smoke test the public URL with a full sandbox purchase and a real webhook.
- [ ] **Step 5:** Run an independent security review of the public surface with the `security-review` skill and fix the findings. Log it. Commit `feat: harden and deploy the public demo`.

### Task 14: Conditional, agent purchase with no buyer present

Only if Task 0 shows vault works in sandbox with no extra PayPal approval. First to cut.

**Files:** `packages/paypal-exec/src/executor.ts`, `apps/receipt-ui/src/demo/story.ts`, tests beside them

- [ ] **Step 1:** Failing tests: `it("charges a saved method with no buyer present only after evaluate returns ALLOW")`, `it("a saved-method charge is one ledger outcome and is captured on creation")`.
- [ ] **Step 2:** Implement, with the saved method as the second-purchase beat. Run the done-check. Decision record. Log it. Commit `feat: let an allowed agent purchase run with no buyer present`.

### Task 15: Submission

The video recording, the Devpost entry, the YouTube upload and the final submission are the builder's. This task prepares everything else.

**Files:**
- Modify: `README.md`
- Create: `private/submission/video-script.md`, `private/submission/devpost.md` (gitignored drafts, following the no-AI-slop writing style)

- [ ] **Step 1:** Rewrite the README opening around two rails, with the public demo link, sandbox buyer credentials, and honest limits including that Razorpay stops at order creation.
- [ ] **Step 2:** Run a clean-clone test: fresh clone, follow the README, reach a working demo. Fix what breaks.
- [ ] **Step 3:** Run an adversarial claims audit with independent agents: every README and Devpost claim gets checked against code or the regenerated report. Fix or remove what fails.
- [ ] **Step 4:** Draft a video script under 3 minutes, and the Devpost text including "what was built after 1 October" with both comparison links. Check it against the official rules as the builder has read them.
- [ ] **Step 5:** Log it. Tag `v2.0-paypal` after the builder approves. Commit `docs: prepare the paypal hackathon submission`.

### Stretch, only if everything above is green by 11 Nov

In order, each with its own plan section when reached: local stdio MCP server exposing Praman as the only spending route, Phase 11 mutation testing, Phase 12 database roles.
