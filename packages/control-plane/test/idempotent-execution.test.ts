import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@praman/db";
import { append } from "@praman/ledger";
import type { PurchaseIntent } from "@praman/policy";
import { generateKeypair, signMandate, type MandateDocument } from "@praman/mandate";
import { SimulatedExecutor, type ExecOutcome, type Executor } from "@praman/razorpay-exec";
import type { Paise } from "@praman/shared";
import { runIntent } from "../src/run-intent.js";

const MERCHANT = "TEST_DUP_MERCH";
const SKU = "TEST_DUP_SKU";

/** Counts real calls to createOrder — the actual claim under test. */
class CountingExecutor implements Executor {
  callCount = 0;
  constructor(private readonly inner: Executor) {}
  async createOrder(amountPaise: Paise, receipt: string): Promise<ExecOutcome> {
    this.callCount += 1;
    return this.inner.createOrder(amountPaise, receipt);
  }
  async findByReceipt(receipt: string) {
    return this.inner.findByReceipt(receipt);
  }
  async capture(paymentId: string, amountPaise: Paise) {
    return this.inner.capture(paymentId, amountPaise);
  }
}

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
    limits: { max_per_txn_paise: "80000", max_total_paise: "500000", max_txns_per_window: 5, window_seconds: 3600 },
    step_up: { threshold_paise: "50000" },
    validity: { not_before: "2026-08-28T00:00:00.000Z", not_after: "2026-12-31T00:00:00.000Z" },
    nonce: "n1",
  };
  return { signed: signMandate(doc, privateKeyPem, "k1"), publicKeyPem };
}

async function seedPriorHistory(mandateId: string) {
  // Bypasses evaluate()'s first-merchant step-up so the test can reach ALLOW.
  await prisma.$transaction((tx) =>
    append(tx, {
      traceId: "trc_seed",
      ts: new Date("2026-08-28T00:00:00.000Z"),
      actor: "praman",
      eventType: "outcome",
      payload: {
        mandate_id: mandateId,
        status: "captured",
        order_id: "order_SEED",
        payment_id: "pay_SEED",
        amount_paise: "1000",
        merchant_id: MERCHANT,
        idempotency_key: "seed",
      },
    }),
  );
}

describe("runIntent never issues a second razorpay call for a duplicate intent", () => {
  it("a second identical intent after a successful run does not call the executor again", async () => {
    const mandateId = "mnd_dup_test_1";
    await seedPriorHistory(mandateId);
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);
    const intent: PurchaseIntent = {
      intent_id: "int_dup_1",
      mandate_id: mandateId,
      merchant_id: MERCHANT,
      line_items: [{ sku: SKU, qty: 1 }],
      requested_at: "2026-08-28T01:00:00.000Z",
      agent_rationale: "test",
    };

    const executor = new CountingExecutor(new SimulatedExecutor());
    const now = new Date();

    const first = await runIntent(intent, signed, publicKeyPem, executor, now, "test-model");
    const second = await runIntent(intent, signed, publicKeyPem, executor, now, "test-model");

    expect(executor.callCount).toBe(1);
    expect(first.kind).toBe("DECIDED");
    expect(second.kind).toBe("DECIDED");
    if (first.kind !== "DECIDED" || second.kind !== "DECIDED") throw new Error("unreachable");
    expect(second.order_id).toBe(first.order_id);
  });

  it("a second identical intent while the first is still pending does not call the executor", async () => {
    const mandateId = "mnd_dup_test_2";
    await seedPriorHistory(mandateId);
    const { signed, publicKeyPem } = buildSignedMandate(mandateId);
    const intent: PurchaseIntent = {
      intent_id: "int_dup_2",
      mandate_id: mandateId,
      merchant_id: MERCHANT,
      line_items: [{ sku: SKU, qty: 1 }],
      requested_at: "2026-08-28T01:00:00.000Z",
      agent_rationale: "test",
    };

    // An executor that never resolves createOrder, simulating call 1 still
    // being in flight (network call sent, no response yet) when call 2 lands.
    class HangingExecutor implements Executor {
      callCount = 0;
      async createOrder(): Promise<ExecOutcome> {
        this.callCount += 1;
        return new Promise(() => {
          /* never resolves within this test */
        });
      }
      async findByReceipt(): Promise<ExecOutcome | null> {
        return null;
      }
      async capture(paymentId: string, amountPaise: Paise): Promise<ExecOutcome> {
        return { order_id: "order_x", status: "captured", amount_paise: amountPaise, payment_id: paymentId, failure_code: null };
      }
    }
    const executor = new HangingExecutor();
    const now = new Date();

    // Fire call 1 but don't await it — it hangs inside createOrder.
    void runIntent(intent, signed, publicKeyPem, executor, now, "test-model");
    // Give T1 time to commit its "pending" record before call 2 starts.
    await new Promise((r) => setTimeout(r, 200));

    const second = await runIntent(intent, signed, publicKeyPem, executor, now, "test-model");

    expect(executor.callCount).toBe(1);
    expect(second.kind).toBe("IN_FLIGHT");
  });
});
