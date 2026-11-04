import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@praman/db";
import { append, deriveState } from "@praman/ledger";
import type { PurchaseIntent } from "@praman/policy";
import { generateKeypair, signMandate, type MandateDocument } from "@praman/mandate";
import { routeAllTo, routeByRail, SimulatedExecutor, type ExecOutcome, type Executor } from "@praman/exec-core";
import { LiveExecutor } from "@praman/razorpay-exec";
import { minor, type Currency, type Rail } from "@praman/shared";
import { runIntent } from "../src/run-intent.js";

const MERCHANT = "TEST_REVOKE_MERCH";
const SKU = "TEST_REVOKE_SKU";

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE ledger_entry, idempotency_record, approval RESTART IDENTITY`;
  await prisma.$executeRaw`DELETE FROM catalog_item WHERE merchant_id = ${MERCHANT}`;
  await prisma.merchant.upsert({
    where: { merchantId: MERCHANT },
    create: { merchantId: MERCHANT, rail: "simulated", currency: "INR" },
    update: { rail: "simulated", currency: "INR" },
  });
  await prisma.catalogItem.create({
    data: { merchantId: MERCHANT, sku: SKU, title: "t", description: "d", category: "food", currency: "INR", priceMinor: 5000n, stockQty: 10 },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

function buildSignedMandate(mandateId: string, currency: Currency = "INR", maxTotalMinor = "500000") {
  const { privateKeyPem, publicKeyPem } = generateKeypair();
  const doc: MandateDocument = {
    mandate_id: mandateId,
    version: 2,
    issuer_id: "usr_t",
    subject_id: "agt_t",
    scope: { merchant_ids: [MERCHANT], categories: ["food"], currency },
    limits: { max_per_txn_minor: "80000", max_total_minor: maxTotalMinor, max_txns_per_window: 5, window_seconds: 3600, max_denials_per_window: 5 },
    step_up: { threshold_minor: "50000" },
    validity: { not_before: "2026-08-28T00:00:00.000Z", not_after: "2026-12-31T00:00:00.000Z" },
    nonce: "n1",
  };
  return { signed: signMandate(doc, privateKeyPem, "k1"), publicKeyPem };
}

describe("runIntent with a mandate in an unsupported currency", () => {
  it("denies AMOUNT_INVALID, not a signature failure, and never calls the executor", async () => {
    const { privateKeyPem, publicKeyPem } = generateKeypair();
    const { signed: valid } = buildSignedMandate("mnd_jpy_test");
    const doc = { ...valid.document, scope: { ...valid.document.scope, currency: "JPY" } } as unknown as MandateDocument;
    const executor = new SimulatedExecutor();
    const createOrder = vi.spyOn(executor, "createOrder");

    const result = await runIntent(
      {
        intent_id: "int_jpy_1",
        mandate_id: "mnd_jpy_test",
        merchant_id: MERCHANT,
        line_items: [{ sku: SKU, qty: 1 }],
        requested_at: "2026-09-01T01:00:00.000Z",
        agent_rationale: "test",
      },
      signMandate(doc, privateKeyPem, "k1"),
      publicKeyPem,
      routeAllTo(executor),
      new Date("2026-09-01T01:00:00.000Z"),
      "test-model",
    );

    expect(result.kind === "DECIDED" && result.internal_reason_code).toBe("AMOUNT_INVALID");
    expect(result.kind === "DECIDED" && result.order_id).toBeNull();
    expect(createOrder).not.toHaveBeenCalled();
  });
});

describe("runIntent with a USD mandate", () => {
  const USD_SKU = "TEST_USD_SKU";
  const NOW = new Date("2026-09-01T01:00:00.000Z");

  function buildIntent(intentId: string, mandateId: string, sku: string): PurchaseIntent {
    return {
      intent_id: intentId,
      mandate_id: mandateId,
      merchant_id: MERCHANT,
      line_items: [{ sku, qty: 1 }],
      requested_at: NOW.toISOString(),
      agent_rationale: "test",
    };
  }

  async function seedTrustedMerchant(mandateId: string) {
    await prisma.$transaction((tx) =>
      append(tx, {
        traceId: `trc_seed_${mandateId}`,
        ts: new Date("2026-08-28T00:30:00.000Z"),
        actor: "praman",
        eventType: "outcome",
        payload: { mandate_id: mandateId, status: "captured", order_id: "o", amount_minor: "100", currency: "USD", merchant_id: MERCHANT, idempotency_key: "seed" },
      }),
    );
  }

  beforeEach(async () => {
    await prisma.catalogItem.create({
      data: { merchantId: MERCHANT, sku: USD_SKU, title: "t", description: "d", category: "food", currency: "USD", priceMinor: 1250n, stockQty: 10 },
    });
  });

  it("buys a USD item and records USD on every event that has an amount", async () => {
    const mandateId = "mnd_usd_allow";
    await seedTrustedMerchant(mandateId);
    const { signed, publicKeyPem } = buildSignedMandate(mandateId, "USD");

    const result = await runIntent(buildIntent("int_usd_allow", mandateId, USD_SKU), signed, publicKeyPem, routeAllTo(new SimulatedExecutor()), NOW, "test-model");

    expect(result.kind === "DECIDED" && result.agent_visible).toEqual({ kind: "ALLOW", amount_minor: 1250n });
    const rows = await prisma.ledgerEntry.findMany({ where: { traceId: result.trace_id }, orderBy: { seq: "asc" } });
    const withAmount = rows.filter((r) => r.eventType === "decision" || r.eventType === "api_call" || r.eventType === "outcome");
    expect(withAmount).toHaveLength(3);
    for (const row of withAmount) {
      expect(row.payload).toMatchObject({ amount_minor: "1250", currency: "USD" });
    }
  });

  it("denies an INR item with no attempt to call the rail and nothing spent", async () => {
    const mandateId = "mnd_usd_mismatch";
    await seedTrustedMerchant(mandateId);
    const { signed, publicKeyPem } = buildSignedMandate(mandateId, "USD");
    const executor = new SimulatedExecutor();
    const createOrder = vi.spyOn(executor, "createOrder");

    const result = await runIntent(buildIntent("int_usd_mismatch", mandateId, SKU), signed, publicKeyPem, routeAllTo(executor), NOW, "test-model");

    expect(result.kind === "DECIDED" && result.agent_visible).toEqual({ kind: "DENY", reason_code: "CURRENCY_MISMATCH" });
    expect(createOrder).not.toHaveBeenCalled();
    expect(await prisma.idempotencyRecord.count({ where: { traceId: result.trace_id } })).toBe(0);
  });

  it("a USD purchase on the Razorpay executor fails with nothing charged and nothing spent", async () => {
    // A merchant misconfigured onto a rail that can't take its currency. Without
    // the executor's refusal, this would go to Razorpay as an INR order for ₹12.50.
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const mandateId = "mnd_usd_razorpay";
      await prisma.merchant.update({ where: { merchantId: MERCHANT }, data: { rail: "razorpay" } });
      await seedTrustedMerchant(mandateId);
      const { signed, publicKeyPem } = buildSignedMandate(mandateId, "USD");

      const result = await runIntent(buildIntent("int_usd_razorpay", mandateId, USD_SKU), signed, publicKeyPem, routeByRail([new LiveExecutor("k", "s")]), NOW, "test-model");

      expect(result.kind === "DECIDED" && result.order_status).toBe("failed");
      expect(fetchMock).not.toHaveBeenCalled();
      const state = await prisma.$transaction((tx) => deriveState(tx, mandateId));
      expect(state.spent_minor).toBe(100n);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a repeat of a USD purchase the Razorpay executor refused gets the same typed answer", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const mandateId = "mnd_usd_razorpay_repeat";
      await prisma.merchant.update({ where: { merchantId: MERCHANT }, data: { rail: "razorpay" } });
      await seedTrustedMerchant(mandateId);
      const { signed, publicKeyPem } = buildSignedMandate(mandateId, "USD");
      const intent = buildIntent("int_usd_razorpay_repeat", mandateId, USD_SKU);
      const route = routeByRail([new LiveExecutor("k", "s")]);

      const first = await runIntent(intent, signed, publicKeyPem, route, NOW, "test-model");
      const second = await runIntent(intent, signed, publicKeyPem, route, NOW, "test-model");

      expect(second).toEqual(first);
      expect(second).toMatchObject({ kind: "DECIDED", order_status: "failed", order_id: "" });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("runIntent ledger events", () => {
  it("records the currency next to the amount on decision, api_call and outcome", async () => {
    const mandateId = "mnd_currency_events";
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);
    await prisma.$transaction((tx) =>
      append(tx, {
        traceId: "trc_currency_seed",
        ts: new Date("2026-08-28T00:30:00.000Z"),
        actor: "praman",
        eventType: "outcome",
        payload: { mandate_id: mandateId, status: "captured", order_id: "o", amount_minor: "1000", merchant_id: MERCHANT, idempotency_key: "seed" },
      }),
    );

    const result = await runIntent(
      {
        intent_id: "int_currency_1",
        mandate_id: mandateId,
        merchant_id: MERCHANT,
        line_items: [{ sku: SKU, qty: 1 }],
        requested_at: "2026-09-01T01:00:00.000Z",
        agent_rationale: "test",
      },
      signed,
      publicKeyPem,
      routeAllTo(new SimulatedExecutor()),
      new Date("2026-09-01T01:00:00.000Z"),
      "test-model",
    );
    expect(result.kind === "DECIDED" && result.agent_visible.kind).toBe("ALLOW");

    const rows = await prisma.ledgerEntry.findMany({ where: { traceId: result.trace_id }, orderBy: { seq: "asc" } });
    const currencyOf = (eventType: string) => {
      const payload = rows.find((r) => r.eventType === eventType)?.payload;
      return payload !== null && typeof payload === "object" && "currency" in payload ? payload.currency : undefined;
    };
    expect(currencyOf("decision")).toBe("INR");
    expect(currencyOf("api_call")).toBe("INR");
    expect(currencyOf("outcome")).toBe("INR");
  });
});

describe("runIntent against a revoked mandate", () => {
  it("denies MANDATE_REVOKED for a fresh intent, exactly what scripts/revoke.ts relies on", async () => {
    const mandateId = "mnd_revoke_test";
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);

    // The same shape scripts/revoke.ts appends — this test exists so that
    // script has a real assertion behind it, not just a manual demo beat.
    await prisma.$transaction((tx) =>
      append(tx, {
        traceId: "trc_revoke_seed",
        ts: new Date("2026-08-28T00:30:00.000Z"),
        actor: "issuer",
        eventType: "mandate_revoked",
        payload: { mandate_id: mandateId, reason: "test revocation" },
      }),
    );

    const intent: PurchaseIntent = {
      intent_id: "int_revoke_1",
      mandate_id: mandateId,
      merchant_id: MERCHANT,
      line_items: [{ sku: SKU, qty: 1 }],
      requested_at: "2026-08-28T01:00:00.000Z",
      agent_rationale: "test",
    };

    const result = await runIntent(intent, signed, publicKeyPem, routeAllTo(new SimulatedExecutor()), new Date(), "test-model");

    expect(result.kind).toBe("DECIDED");
    if (result.kind !== "DECIDED") throw new Error("unreachable");
    expect(result.internal_reason_code).toBe("MANDATE_REVOKED");
    expect(result.order_id).toBeNull();
  });
});

describe("F1: forged-signature intents do not lock out the real mandate holder", () => {
  it("still evaluates a legitimate intent after max_denials_per_window forged-signature attempts under the same claimed mandate_id", async () => {
    const mandateId = "mnd_lockout_test";
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);
    // max_denials_per_window is 5 for this mandate (see buildSignedMandate).
    const forged = { ...signed, signature: { ...signed.signature, value: "not-a-real-signature" } };

    const baseIntent = {
      intent_id: "int_forged",
      mandate_id: mandateId,
      merchant_id: MERCHANT,
      line_items: [{ sku: SKU, qty: 1 }] as const,
      requested_at: "2026-08-28T01:00:00.000Z",
      agent_rationale: "attacker probing a known mandate_id",
    };

    for (let i = 0; i < 5; i++) {
      const forgedIntent: PurchaseIntent = { ...baseIntent, intent_id: `int_forged_${i.toString()}` };
      const r = await runIntent(forgedIntent, forged, publicKeyPem, routeAllTo(new SimulatedExecutor()), new Date(), "test-model");
      if (r.kind !== "DECIDED") throw new Error("unreachable");
      expect(r.internal_reason_code).toBe("MANDATE_SIGNATURE_INVALID");
    }

    const legitimateIntent: PurchaseIntent = { ...baseIntent, intent_id: "int_legit" };
    const result = await runIntent(legitimateIntent, signed, publicKeyPem, routeAllTo(new SimulatedExecutor()), new Date(), "test-model");

    expect(result.kind).toBe("DECIDED");
    if (result.kind !== "DECIDED") throw new Error("unreachable");
    // Before the fix this was DENIAL_RATE_EXCEEDED — the 5 forged-signature
    // denials, never proven to belong to this mandate, still counted against
    // it. STEP_UP_FIRST_MERCHANT (not DENY) proves evaluate() was actually
    // reached: this mandate's first-ever transaction with MERCHANT correctly
    // requires human approval, unrelated to the lockout bug being tested here.
    expect(result.internal_reason_code).toBe("STEP_UP_FIRST_MERCHANT");
    expect(result.approval_id).not.toBeNull();
  });
});

describe("runIntent routing", () => {
  const NOW = new Date("2026-09-01T01:00:00.000Z");

  function buildIntent(intentId: string, mandateId: string): PurchaseIntent {
    return {
      intent_id: intentId,
      mandate_id: mandateId,
      merchant_id: MERCHANT,
      line_items: [{ sku: SKU, qty: 1 }],
      requested_at: NOW.toISOString(),
      agent_rationale: "test",
    };
  }

  async function seedTrustedMerchant(mandateId: string) {
    await prisma.$transaction((tx) =>
      append(tx, {
        traceId: `trc_seed_${mandateId}`,
        ts: new Date("2026-08-28T00:30:00.000Z"),
        actor: "praman",
        eventType: "outcome",
        payload: { mandate_id: mandateId, status: "captured", order_id: "o", amount_minor: "1000", currency: "INR", merchant_id: MERCHANT, idempotency_key: "seed" },
      }),
    );
  }

  /** A simulated executor wearing another rail's name, standing in for that rail. */
  function executorOn(rail: Rail, respond?: (outcome: ExecOutcome) => ExecOutcome): Executor {
    const inner = new SimulatedExecutor();
    return {
      rail,
      createOrder: async (req) => {
        const outcome = { ...(await inner.createOrder(req)), rail };
        return respond === undefined ? outcome : respond(outcome);
      },
      findOrder: (lookup) => inner.findOrder(lookup),
      capture: (req) => inner.capture(req),
    };
  }

  async function configureMerchant(rail: Rail) {
    await prisma.merchant.update({ where: { merchantId: MERCHANT }, data: { rail } });
  }

  it("routes to the rail configured for the merchant, ignoring the intent", async () => {
    const mandateId = "mnd_route_config";
    await seedTrustedMerchant(mandateId);
    await configureMerchant("razorpay");
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);
    const asked: Rail[] = [];
    const razorpay = executorOn("razorpay");
    const paypal = executorOn("paypal");
    const create = vi.spyOn(paypal, "createOrder");

    // An intent cannot pick a rail. If this field were ever read, the order would go to PayPal.
    const intent = { ...buildIntent("int_route_config", mandateId), rail: "paypal", provider: "paypal" };
    const result = await runIntent(
      intent,
      signed,
      publicKeyPem,
      (rail) => {
        asked.push(rail);
        return rail === "razorpay" ? razorpay : paypal;
      },
      NOW,
      "test-model",
    );

    expect(asked).toEqual(["razorpay"]);
    expect(create).not.toHaveBeenCalled();
    expect(result.kind === "DECIDED" && result.order_status).toBe("captured");
  });

  it.each([
    ["no executor exists for the merchant's rail", "paypal" as const],
    ["the merchant has no configuration at all", null],
  ])("denies cleanly with no call when %s", async (_name, rail) => {
    const mandateId = `mnd_route_none_${String(rail)}`;
    await seedTrustedMerchant(mandateId);
    if (rail === null) await prisma.merchant.delete({ where: { merchantId: MERCHANT } });
    else await configureMerchant(rail);
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);
    const razorpay = executorOn("razorpay");
    const create = vi.spyOn(razorpay, "createOrder");

    const result = await runIntent(buildIntent(`int_route_none_${String(rail)}`, mandateId), signed, publicKeyPem, routeByRail([razorpay]), NOW, "test-model");

    expect(result.kind === "DECIDED" && result.agent_visible).toEqual({ kind: "DENY", reason_code: "MERCHANT_OUT_OF_SCOPE" });
    expect(result.kind === "DECIDED" && result.internal_reason_code).toBe("MERCHANT_OUT_OF_SCOPE");
    expect(create).not.toHaveBeenCalled();
    expect(await prisma.idempotencyRecord.count({ where: { traceId: result.trace_id } })).toBe(0);
    const decisions = await prisma.ledgerEntry.findMany({ where: { traceId: result.trace_id, eventType: "decision" } });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.payload).toMatchObject({ kind: "DENY", reason_code: "MERCHANT_OUT_OF_SCOPE" });
  });

  it("a policy denial is reported as itself, even when the merchant has no executor", async () => {
    const mandateId = "mnd_route_policy_first";
    await seedTrustedMerchant(mandateId);
    await configureMerchant("paypal");
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);
    const intent: PurchaseIntent = { ...buildIntent("int_route_policy_first", mandateId), line_items: [{ sku: "NO_SUCH_SKU", qty: 1 }] };

    const result = await runIntent(intent, signed, publicKeyPem, routeByRail([]), NOW, "test-model");

    expect(result.kind === "DECIDED" && result.internal_reason_code).toBe("SKU_UNKNOWN");
  });

  it("does not ask a human to approve a purchase no executor can carry out", async () => {
    const mandateId = "mnd_route_no_stepup";
    await configureMerchant("paypal");
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);

    const result = await runIntent(buildIntent("int_route_no_stepup", mandateId), signed, publicKeyPem, routeByRail([]), NOW, "test-model");

    expect(result.kind === "DECIDED" && result.internal_reason_code).toBe("MERCHANT_OUT_OF_SCOPE");
    expect(result.kind === "DECIDED" && result.approval_id).toBeNull();
    expect(await prisma.approval.count({ where: { traceId: result.trace_id } })).toBe(0);
  });

  it("records rail and currency on the api_call and outcome events", async () => {
    const mandateId = "mnd_route_events";
    await seedTrustedMerchant(mandateId);
    await configureMerchant("razorpay");
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);

    const result = await runIntent(buildIntent("int_route_events", mandateId), signed, publicKeyPem, routeByRail([executorOn("razorpay")]), NOW, "test-model");

    const record = await prisma.idempotencyRecord.findFirst({ where: { traceId: result.trace_id } });
    expect(record).toMatchObject({ rail: "razorpay", currency: "INR" });
    const apiCall = await prisma.ledgerEntry.findFirst({ where: { traceId: result.trace_id, eventType: "api_call" } });
    expect(apiCall?.payload).toMatchObject({ rail: "razorpay", currency: "INR", merchant_id: MERCHANT, idempotency_key: record?.key });
    expect(apiCall?.payload).not.toHaveProperty("provider");
    const outcome = await prisma.ledgerEntry.findFirst({ where: { traceId: result.trace_id, eventType: "outcome" } });
    expect(outcome?.payload).toMatchObject({ rail: "razorpay", currency: "INR", failure_code: null });
    expect(outcome?.payload).not.toHaveProperty("provider");
  });

  it("rejects an executor outcome whose currency differs from the request", async () => {
    const mandateId = "mnd_route_wrong_currency";
    await seedTrustedMerchant(mandateId);
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);
    const before = await prisma.$transaction((tx) => deriveState(tx, mandateId));
    const executor = executorOn("simulated", (outcome) => ({ ...outcome, status: "created", currency: "USD", approve_url: "https://sandbox.example.test/pay" }));
    const create = vi.spyOn(executor, "createOrder");
    const intent = buildIntent("int_route_wrong_currency", mandateId);

    const result = await runIntent(intent, signed, publicKeyPem, routeAllTo(executor), NOW, "test-model");

    // Not believed, so no buyer gets sent to pay it, and a caller can't read it as a success.
    expect(result).toMatchObject({ kind: "DECIDED", order_status: "mismatch", approve_url: null });
    const record = await prisma.idempotencyRecord.findFirst({ where: { traceId: result.trace_id } });
    expect(record?.status).toBe("succeeded");
    const outcome = await prisma.ledgerEntry.findFirst({ where: { traceId: result.trace_id, eventType: "outcome" } });
    expect(outcome?.payload).toMatchObject({
      status: "mismatch",
      amount_minor: "5000",
      currency: "INR",
      failure_code: "RAIL_CURRENCY_MISMATCH",
      rail_status: "created",
      rail_currency: "USD",
    });

    // The order exists at the rail, so it holds what was authorised.
    const after = await prisma.$transaction((tx) => deriveState(tx, mandateId));
    expect(after.spent_minor).toBe(before.spent_minor + 5000n);
    expect(after.txn_timestamps).toHaveLength(before.txn_timestamps.length + 1);

    const repeat = await runIntent(intent, signed, publicKeyPem, routeAllTo(executor), NOW, "test-model");
    expect(repeat).toEqual(result);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("captured orders in the wrong currency use up the signed budget, so they can't go on forever", async () => {
    const mandateId = "mnd_route_currency_budget";
    await seedTrustedMerchant(mandateId);
    const { signed, publicKeyPem } = buildSignedMandate(mandateId, "INR", "12000");
    let n = 0;
    const executor = executorOn("simulated", (outcome) => ({ ...outcome, order_id: `order_${String(++n)}`, status: "captured", payment_id: `pay_${String(n)}`, currency: "USD" }));

    const results = [];
    for (const i of [1, 2, 3]) {
      results.push(await runIntent(buildIntent(`int_route_currency_budget_${String(i)}`, mandateId), signed, publicKeyPem, routeAllTo(executor), NOW, "test-model"));
    }

    expect(results.map((r) => r.kind === "DECIDED" && r.order_status)).toEqual(["mismatch", "mismatch", null]);
    expect(results[2]?.kind === "DECIDED" && results[2].internal_reason_code).toBe("MANDATE_BUDGET_EXHAUSTED");
    expect(n).toBe(2);
    const state = await prisma.$transaction((tx) => deriveState(tx, mandateId));
    expect(state.spent_minor).toBe(11000n);
  });

  it("an order reported for 1 minor unit still uses up the signed budget at its authorised price", async () => {
    const mandateId = "mnd_route_amount_low";
    await seedTrustedMerchant(mandateId);
    const { signed, publicKeyPem } = buildSignedMandate(mandateId, "INR", "12000");
    let calls = 0;
    const executor = executorOn("simulated", (outcome) => {
      calls += 1;
      return { ...outcome, status: "created", amount_minor: minor(1n), approve_url: "https://sandbox.example.test/pay" };
    });

    const results = [];
    for (const i of [1, 2, 3]) {
      results.push(await runIntent(buildIntent(`int_route_amount_low_${String(i)}`, mandateId), signed, publicKeyPem, routeAllTo(executor), NOW, "test-model"));
    }

    expect(results.map((r) => r.kind === "DECIDED" && r.order_status)).toEqual(["mismatch", "mismatch", null]);
    expect(results[0]).toMatchObject({ approve_url: null });
    expect(results[2]?.kind === "DECIDED" && results[2].internal_reason_code).toBe("MANDATE_BUDGET_EXHAUSTED");
    expect(calls).toBe(2);
    const state = await prisma.$transaction((tx) => deriveState(tx, mandateId));
    expect(state.spent_minor).toBe(11000n);
    const outcome = await prisma.ledgerEntry.findFirst({ where: { traceId: results[0]?.trace_id ?? "", eventType: "outcome" } });
    expect(outcome?.payload).toMatchObject({ status: "mismatch", amount_minor: "5000", rail_amount_minor: "1", failure_code: "RAIL_AMOUNT_MISMATCH" });
  });

  it("an order reported for more than was authorised counts at the higher figure", async () => {
    const mandateId = "mnd_route_amount_high";
    await seedTrustedMerchant(mandateId);
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);
    const executor = executorOn("simulated", (outcome) => ({ ...outcome, status: "created", amount_minor: minor(9000n) }));

    const result = await runIntent(buildIntent("int_route_amount_high", mandateId), signed, publicKeyPem, routeAllTo(executor), NOW, "test-model");

    expect(result).toMatchObject({ kind: "DECIDED", order_status: "mismatch" });
    const state = await prisma.$transaction((tx) => deriveState(tx, mandateId));
    expect(state.spent_minor).toBe(10000n);
  });

  it("a mismatched order earns the merchant no trust, so the next purchase still steps up", async () => {
    const mandateId = "mnd_route_currency_trust";
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);
    await prisma.$transaction((tx) =>
      append(tx, {
        traceId: `trc_seed_${mandateId}`,
        ts: new Date("2026-08-28T00:30:00.000Z"),
        actor: "praman",
        eventType: "outcome",
        payload: { mandate_id: mandateId, status: "mismatch", order_id: "o", amount_minor: "1000", currency: "INR", merchant_id: MERCHANT, idempotency_key: "seed" },
      }),
    );

    const result = await runIntent(buildIntent("int_route_currency_trust", mandateId), signed, publicKeyPem, routeAllTo(new SimulatedExecutor()), NOW, "test-model");

    expect(result.kind === "DECIDED" && result.agent_visible.kind).toBe("STEP_UP");
  });

  it("hands back the rail's approve_url, and again on a repeat of the same intent", async () => {
    const mandateId = "mnd_route_approve_url";
    await seedTrustedMerchant(mandateId);
    await configureMerchant("paypal");
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);
    const approveUrl = "https://sandbox.example.test/checkout?token=1";
    const paypal = executorOn("paypal", (outcome) => ({ ...outcome, status: "created", payment_id: null, approve_url: approveUrl }));
    const intent = buildIntent("int_route_approve_url", mandateId);

    const first = await runIntent(intent, signed, publicKeyPem, routeByRail([paypal]), NOW, "test-model");
    const second = await runIntent(intent, signed, publicKeyPem, routeByRail([paypal]), NOW, "test-model");

    expect(first.kind === "DECIDED" && first.approve_url).toBe(approveUrl);
    expect(second.kind === "DECIDED" && second.approve_url).toBe(approveUrl);
  });

  it("has a null approve_url when nothing was attempted", async () => {
    const mandateId = "mnd_route_no_url";
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);

    const result = await runIntent(buildIntent("int_route_no_url", mandateId), signed, publicKeyPem, routeAllTo(new SimulatedExecutor()), NOW, "test-model");

    expect(result.kind === "DECIDED" && result.agent_visible.kind).toBe("STEP_UP");
    expect(result.kind === "DECIDED" && result.approve_url).toBeNull();
  });
});
