import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@praman/db";
import { append } from "@praman/ledger";
import type { PurchaseIntent } from "@praman/policy";
import { generateKeypair, signMandate, type MandateDocument } from "@praman/mandate";
import { LatchedExecutor, routeAllTo } from "@praman/exec-core";
import { runIntent, type RunResult } from "../src/run-intent.js";

const MERCHANT = "TEST_CONCURRENT_MERCH";
const SKU = "TEST_CONCURRENT_SKU";
/** ₹1,000 a unit, against a ₹5,000 budget: room for five orders, not twenty. */
const PRICE = 100_000n;
const MAX_TOTAL = 500_000n;
const MAX_TXNS = 8;
const NOW = new Date("2026-11-08T10:00:00.000Z");

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE ledger_entry, idempotency_record, approval RESTART IDENTITY`;
  await prisma.$executeRaw`DELETE FROM catalog_item WHERE merchant_id = ${MERCHANT}`;
  await prisma.merchant.upsert({
    where: { merchantId: MERCHANT },
    create: { merchantId: MERCHANT, rail: "simulated", currency: "INR" },
    update: { rail: "simulated", currency: "INR" },
  });
  await prisma.catalogItem.create({
    data: { merchantId: MERCHANT, sku: SKU, title: "t", description: "d", category: "food", currency: "INR", priceMinor: PRICE, stockQty: 100 },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

function buildSignedMandate(mandateId: string) {
  const { privateKeyPem, publicKeyPem } = generateKeypair();
  const doc: MandateDocument = {
    mandate_id: mandateId,
    version: 2,
    issuer_id: "usr_t",
    subject_id: "agt_t",
    scope: { merchant_ids: [MERCHANT], categories: ["food"], currency: "INR" },
    limits: {
      max_per_txn_minor: "200000",
      max_total_minor: String(MAX_TOTAL),
      max_txns_per_window: MAX_TXNS,
      window_seconds: 3600,
      max_denials_per_window: 20,
    },
    step_up: { threshold_minor: "300000" },
    validity: { not_before: "2026-08-28T00:00:00.000Z", not_after: "2026-12-31T00:00:00.000Z" },
    nonce: "n1",
  };
  return { signed: signMandate(doc, privateKeyPem, "k1"), publicKeyPem };
}

/** A zero-amount order at this merchant, long before the window, so the first-merchant step-up doesn't apply. */
async function seedMerchantHistory(mandateId: string) {
  await prisma.$transaction((tx) =>
    append(tx, {
      traceId: "trc_seed",
      ts: new Date("2026-08-28T00:00:00.000Z"),
      actor: "praman",
      eventType: "outcome",
      payload: { mandate_id: mandateId, status: "captured", order_id: "order_SEED", payment_id: "pay_SEED", amount_minor: "0", merchant_id: MERCHANT, idempotency_key: "seed" },
    }),
  );
}

async function waitUntil(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the intents to reach the latch");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("concurrent intents under one mandate", () => {
  it("20 concurrent intents never create more than the mandate's budget", async () => {
    const mandateId = "mnd_concurrent_1";
    await seedMerchantHistory(mandateId);
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);
    const executor = new LatchedExecutor();

    // Twenty distinct carts, so twenty distinct idempotency keys. Every call is held at
    // the latch, so each intent sits between T1 and T2 while the next one is evaluated.
    let settled = 0;
    const runs: Promise<RunResult>[] = Array.from({ length: 20 }, (_, i) => {
      const intent: PurchaseIntent = {
        intent_id: `int_concurrent_${String(i)}`,
        mandate_id: mandateId,
        merchant_id: MERCHANT,
        line_items: [{ sku: SKU, qty: 1 }],
        requested_at: "2026-11-08T09:59:00.000Z",
        agent_rationale: "test",
      };
      return runIntent(intent, signed, publicKeyPem, routeAllTo(executor), NOW, "test-model").finally(() => {
        settled += 1;
      });
    });

    // Every intent has either been refused or is waiting on the rail.
    await waitUntil(() => settled + executor.waiting === 20);
    executor.release();
    const results = await Promise.all(runs);

    const created = results.filter((r) => r.kind === "DECIDED" && r.order_id !== null && r.order_status !== "failed");
    const createdTotal = BigInt(created.length) * PRICE;
    expect(results.every((r) => r.kind === "DECIDED")).toBe(true);
    expect(createdTotal).toBeLessThanOrEqual(MAX_TOTAL);
    expect(created.length).toBeLessThanOrEqual(MAX_TXNS);
  }, 30_000);
});
