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
