import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@praman/db";
import { deriveState, verifyChain } from "@praman/ledger";
import type { PurchaseIntent } from "@praman/policy";
import { generateKeypair, signMandate, type MandateDocument } from "@praman/mandate";
import { routeAllTo, SimulatedExecutor } from "@praman/exec-core";
import { revokeMandate } from "../src/revoke-mandate.js";
import { runIntent } from "../src/run-intent.js";

const MERCHANT = "TEST_REVOKE_FN_MERCH";
const SKU = "TEST_REVOKE_FN_SKU";
const NOW = new Date("2026-08-28T00:30:00.000Z");

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

function signed(mandateId: string) {
  const { privateKeyPem, publicKeyPem } = generateKeypair();
  const doc: MandateDocument = {
    mandate_id: mandateId,
    version: 2,
    issuer_id: "usr_t",
    subject_id: "agt_t",
    scope: { merchant_ids: [MERCHANT], categories: ["food"], currency: "INR" },
    limits: { max_per_txn_minor: "80000", max_total_minor: "500000", max_txns_per_window: 5, window_seconds: 3600, max_denials_per_window: 5 },
    step_up: { threshold_minor: "50000" },
    validity: { not_before: "2026-01-01T00:00:00.000Z", not_after: "2099-01-01T00:00:00.000Z" },
    nonce: "n",
  };
  return { signed: signMandate(doc, privateKeyPem, "k1"), publicKeyPem };
}

describe("revokeMandate", () => {
  it("appends one mandate_revoked row on its own trace, and the chain still verifies", async () => {
    const { seq } = await revokeMandate({ mandateId: "mnd_rev_fn", reason: "lost the card", traceId: "trc_rev_fn", now: NOW });

    const rows = await prisma.ledgerEntry.findMany({ orderBy: { seq: "asc" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ seq, traceId: "trc_rev_fn", actor: "issuer", eventType: "mandate_revoked", payload: { mandate_id: "mnd_rev_fn", reason: "lost the card" } });
    expect((await prisma.$transaction((tx) => verifyChain(tx))).ok).toBe(true);
    expect((await prisma.$transaction((tx) => deriveState(tx, "mnd_rev_fn"))).revoked).toBe(true);
  });

  it("makes the next intent under that mandate DENY MANDATE_REVOKED, with no order", async () => {
    const mandateId = "mnd_rev_fn_deny";
    const { signed: mandate, publicKeyPem } = signed(mandateId);
    await revokeMandate({ mandateId, reason: "test", traceId: "trc_rev_fn_deny", now: NOW });

    const intent: PurchaseIntent = {
      intent_id: "int_rev_fn_1",
      mandate_id: mandateId,
      merchant_id: MERCHANT,
      line_items: [{ sku: SKU, qty: 1 }],
      requested_at: "2026-08-28T01:00:00.000Z",
      agent_rationale: "test",
    };
    const result = await runIntent(intent, mandate, publicKeyPem, routeAllTo(new SimulatedExecutor()), new Date(), "test-model");

    expect(result).toMatchObject({ kind: "DECIDED", internal_reason_code: "MANDATE_REVOKED", order_id: null, agent_visible: { kind: "DENY", reason_code: "MANDATE_REVOKED" } });
    const outcomes = await prisma.ledgerEntry.count({ where: { eventType: "outcome" } });
    expect(outcomes).toBe(0);
  });

  it("leaves another mandate untouched", async () => {
    await revokeMandate({ mandateId: "mnd_rev_fn_a", reason: "test", traceId: "trc_rev_fn_a", now: NOW });
    expect((await prisma.$transaction((tx) => deriveState(tx, "mnd_rev_fn_b"))).revoked).toBe(false);
  });
});
