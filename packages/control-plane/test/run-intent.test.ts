import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@praman/db";
import { append, deriveState } from "@praman/ledger";
import type { PurchaseIntent } from "@praman/policy";
import { generateKeypair, signMandate, type MandateDocument } from "@praman/mandate";
import { LiveExecutor, SimulatedExecutor } from "@praman/razorpay-exec";
import type { Currency } from "@praman/shared";
import { runIntent } from "../src/run-intent.js";

const MERCHANT = "TEST_REVOKE_MERCH";
const SKU = "TEST_REVOKE_SKU";

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE ledger_entry, idempotency_record RESTART IDENTITY`;
  await prisma.$executeRaw`DELETE FROM catalog_item WHERE merchant_id = ${MERCHANT}`;
  await prisma.catalogItem.create({
    data: { merchantId: MERCHANT, sku: SKU, title: "t", description: "d", category: "food", currency: "INR", priceMinor: 5000n, stockQty: 10 },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

function buildSignedMandate(mandateId: string, currency: Currency = "INR") {
  const { privateKeyPem, publicKeyPem } = generateKeypair();
  const doc: MandateDocument = {
    mandate_id: mandateId,
    version: 2,
    issuer_id: "usr_t",
    subject_id: "agt_t",
    scope: { merchant_ids: [MERCHANT], categories: ["food"], currency },
    limits: { max_per_txn_minor: "80000", max_total_minor: "500000", max_txns_per_window: 5, window_seconds: 3600, max_denials_per_window: 5 },
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
      executor,
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

    const result = await runIntent(buildIntent("int_usd_allow", mandateId, USD_SKU), signed, publicKeyPem, new SimulatedExecutor(), NOW, "test-model");

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

    const result = await runIntent(buildIntent("int_usd_mismatch", mandateId, SKU), signed, publicKeyPem, executor, NOW, "test-model");

    expect(result.kind === "DECIDED" && result.agent_visible).toEqual({ kind: "DENY", reason_code: "CURRENCY_MISMATCH" });
    expect(createOrder).not.toHaveBeenCalled();
    expect(await prisma.idempotencyRecord.count({ where: { traceId: result.trace_id } })).toBe(0);
  });

  it("a USD purchase on the Razorpay executor fails with nothing charged and nothing spent", async () => {
    // The gap until rails are routed: without the executor's refusal, this would
    // go to Razorpay as an INR order for ₹12.50.
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const mandateId = "mnd_usd_razorpay";
      await seedTrustedMerchant(mandateId);
      const { signed, publicKeyPem } = buildSignedMandate(mandateId, "USD");

      const result = await runIntent(buildIntent("int_usd_razorpay", mandateId, USD_SKU), signed, publicKeyPem, new LiveExecutor("k", "s"), NOW, "test-model");

      expect(result.kind === "DECIDED" && result.order_status).toBe("failed");
      expect(fetchMock).not.toHaveBeenCalled();
      const state = await prisma.$transaction((tx) => deriveState(tx, mandateId));
      expect(state.spent_minor).toBe(100n);
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
      new SimulatedExecutor(),
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

    const result = await runIntent(intent, signed, publicKeyPem, new SimulatedExecutor(), new Date(), "test-model");

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
      const r = await runIntent(forgedIntent, forged, publicKeyPem, new SimulatedExecutor(), new Date(), "test-model");
      if (r.kind !== "DECIDED") throw new Error("unreachable");
      expect(r.internal_reason_code).toBe("MANDATE_SIGNATURE_INVALID");
    }

    const legitimateIntent: PurchaseIntent = { ...baseIntent, intent_id: "int_legit" };
    const result = await runIntent(legitimateIntent, signed, publicKeyPem, new SimulatedExecutor(), new Date(), "test-model");

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
