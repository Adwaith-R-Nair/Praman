import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@praman/db";
import { append } from "@praman/ledger";
import type { PurchaseIntent } from "@praman/policy";
import { generateKeypair, signMandate, type MandateDocument } from "@praman/mandate";
import { SimulatedExecutor } from "@praman/razorpay-exec";
import { runIntent } from "../src/run-intent.js";

const MERCHANT = "TEST_REVOKE_MERCH";
const SKU = "TEST_REVOKE_SKU";

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE ledger_entry, idempotency_record RESTART IDENTITY`;
  await prisma.$executeRaw`DELETE FROM catalog_item WHERE merchant_id = ${MERCHANT}`;
  await prisma.catalogItem.create({
    data: { merchantId: MERCHANT, sku: SKU, title: "t", description: "d", category: "food", pricePaise: 5000n, stockQty: 10 },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

function buildSignedMandate(mandateId: string) {
  const { privateKeyPem, publicKeyPem } = generateKeypair();
  const doc: MandateDocument = {
    mandate_id: mandateId,
    version: 1,
    issuer_id: "usr_t",
    subject_id: "agt_t",
    scope: { merchant_ids: [MERCHANT], categories: ["food"], currency: "INR" },
    limits: { max_per_txn_paise: "80000", max_total_paise: "500000", max_txns_per_window: 5, window_seconds: 3600, max_denials_per_window: 5 },
    step_up: { threshold_paise: "50000" },
    validity: { not_before: "2026-08-28T00:00:00.000Z", not_after: "2026-12-31T00:00:00.000Z" },
    nonce: "n1",
  };
  return { signed: signMandate(doc, privateKeyPem, "k1"), publicKeyPem };
}

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
    // denials, never proven to belong to this mandate, still counted against it.
    expect(result.internal_reason_code).toBe("OK");
    expect(result.order_id).not.toBeNull();
  });
});
