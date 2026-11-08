import { expect } from "vitest";
import { prisma } from "@praman/db";
import { append } from "@praman/ledger";
import type { PurchaseIntent } from "@praman/policy";
import { generateKeypair, signMandate, type MandateDocument } from "@praman/mandate";
import { routeByRail, type CaptureRequest, type CreateOrderRequest, type ExecOutcome, type Executor, type OrderLookup, type RefundOutcome, type RefundRequest } from "@praman/exec-core";
import type { Minor, Rail } from "@praman/shared";
import { runIntent } from "../../src/run-intent.js";

export const MERCHANT = "TEST_CHECKOUT_MERCH";
export const SKU = "TEST_CHECKOUT_SKU";
export const PRICE = 1250n;
/** Ledger time for the order. The release window is measured from here. */
export const T0 = new Date("2026-11-08T10:00:00.000Z");

interface FakeOrder {
  readonly id: string;
  readonly amount: Minor;
  approved: boolean;
  captured: boolean;
  /** PayPal took a capture and is still completing it. Reads show the order as approved, not captured. */
  completing: boolean;
}

/**
 * A rail with a buyer checkout, standing in for PayPal so these tests run with no
 * network. It answers on rail "paypal", because that is what the merchant row names
 * and what the release sweep looks for. Every knob is something PayPal can do.
 */
export class CheckoutExecutor implements Executor {
  constructor(readonly rail: Rail = "paypal") {}
  readonly #orders = new Map<string, FakeOrder>();
  readonly #byKey = new Map<string, string>();
  #n = 0;
  readonly captureCalls: CaptureRequest[] = [];
  readonly findCalls: OrderLookup[] = [];

  /** What createOrder reports, when it should misreport (D-33). */
  createAmount: Minor | null = null;
  /** What a read reports as the order's amount. */
  quoteAmount: Minor | null = null;
  /** How capture answers. */
  captureAnswer: "capture" | "refuse" | "refuse_but_captured" | "throw" | "throw_but_captured" | "throw_completing" = "capture";
  refuseCode = "ORDER_NOT_APPROVED";
  findThrows = false;
  /** Lets two captures overlap. */
  captureDelayMs = 0;
  /** A charge to a saved method: PayPal captures as it creates, with no checkout (D-49). */
  captureOnCreate = false;

  readonly refundCalls: RefundRequest[] = [];
  /** How refund answers. "throw_but_refunded": PayPal made the refund and the answer was lost. */
  refundAnswer: "refund" | "pending" | "refuse" | "throw" | "throw_but_refunded" = "refund";
  refuseRefundCode = "REFUND_NOT_ALLOWED";
  /** What a refund reports as its amount, when it should misreport. */
  refundAmount: Minor | null = null;
  /** Lets two refunds overlap. */
  refundDelayMs = 0;
  /** Refunds by PayPal-Request-Id, and which captures are refunded in full. */
  readonly #refunds = new Map<string, { id: string; paymentId: string; amount: Minor; status: "refunded" | "pending" }>();
  readonly #refundedCaptures = new Set<string>();

  #view(o: FakeOrder): ExecOutcome {
    return {
      rail: this.rail,
      order_id: o.id,
      status: o.captured ? "captured" : "created",
      amount_minor: this.quoteAmount ?? o.amount,
      currency: "USD",
      payment_id: o.captured ? `CAP_${o.id}` : null,
      approve_url: o.captured ? null : `https://www.sandbox.paypal.com/checkoutnow?token=${o.id}`,
      failure_code: null,
    };
  }

  async createOrder(req: CreateOrderRequest): Promise<ExecOutcome> {
    const existing = this.#byKey.get(req.idempotency_key);
    const id = existing ?? `PP${String(++this.#n).padStart(6, "0")}`;
    if (existing === undefined) {
      this.#byKey.set(req.idempotency_key, id);
      this.#orders.set(id, { id, amount: this.createAmount ?? req.amount_minor, approved: this.captureOnCreate, captured: this.captureOnCreate, completing: false });
    }
    return this.#view(this.order(id));
  }

  async findOrder(lookup: OrderLookup): Promise<ExecOutcome | null> {
    this.findCalls.push(lookup);
    if (this.findThrows) throw new Error("ETIMEDOUT");
    const id = lookup.order_id ?? this.#byKey.get(lookup.idempotency_key);
    const o = id === undefined ? undefined : this.#orders.get(id);
    return o === undefined ? null : this.#view(o);
  }

  async capture(req: CaptureRequest): Promise<ExecOutcome> {
    this.captureCalls.push(req);
    if (this.captureDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.captureDelayMs));
    const o = this.order(req.order_id);
    const failed = (code: string): ExecOutcome => ({ ...this.#view(o), status: "failed", payment_id: null, approve_url: null, failure_code: code });
    // paypal-exec reads ORDER_COMPLETION_IN_PROGRESS back, sees no capture yet, and throws unknown (D-39).
    if (o.completing) throw new Error("PayPal: capture answered with an order that isn't captured");
    switch (this.captureAnswer) {
      case "throw":
        throw new Error("ECONNRESET");
      case "throw_but_captured":
        o.captured = true;
        throw new Error("ECONNRESET");
      case "throw_completing":
        o.completing = true;
        throw new Error("ECONNRESET");
      case "refuse":
        return failed(this.refuseCode);
      case "refuse_but_captured":
        o.captured = true;
        return failed(this.refuseCode);
      case "capture":
        if (!o.approved) return failed("ORDER_NOT_APPROVED");
        o.captured = true;
        return this.#view(o);
    }
  }

  /**
   * Like PayPal (D-68): the same key answers with the same refund, whatever the amount;
   * a new key on a capture already refunded in full is CAPTURE_FULLY_REFUNDED.
   */
  async refund(req: RefundRequest): Promise<RefundOutcome> {
    this.refundCalls.push(req);
    if (this.refundDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.refundDelayMs));
    const answer = (r: { id: string; paymentId: string; amount: Minor; status: "refunded" | "pending" }): RefundOutcome => ({
      rail: this.rail,
      payment_id: r.paymentId,
      refund_id: r.id,
      status: r.status,
      amount_minor: this.refundAmount ?? r.amount,
      currency: "USD",
      failure_code: null,
    });
    const failed = (code: string): RefundOutcome => ({ rail: this.rail, payment_id: req.payment_id, refund_id: null, status: "failed", amount_minor: req.amount_minor, currency: req.currency, failure_code: code });
    const existing = this.#refunds.get(req.idempotency_key);
    if (existing !== undefined) return answer(existing);
    if (this.#refundedCaptures.has(req.payment_id)) return failed("CAPTURE_FULLY_REFUNDED");
    const make = (status: "refunded" | "pending") => {
      const r = { id: `REF${String(this.#refunds.size + 1).padStart(4, "0")}`, paymentId: req.payment_id, amount: req.amount_minor, status };
      this.#refunds.set(req.idempotency_key, r);
      this.#refundedCaptures.add(req.payment_id);
      return r;
    };
    switch (this.refundAnswer) {
      case "throw":
        throw new Error("ECONNRESET");
      case "throw_but_refunded":
        make("refunded");
        throw new Error("ECONNRESET");
      case "refuse":
        return failed(this.refuseRefundCode);
      case "pending":
        return answer(make("pending"));
      case "refund":
        return answer(make("refunded"));
    }
  }

  /** PayPal finishes every pending refund. */
  finishRefunds(): void {
    for (const r of this.#refunds.values()) r.status = "refunded";
  }

  /** How many refunds PayPal holds, across all keys. */
  get refundsMade(): number {
    return this.#refunds.size;
  }

  order(id: string): FakeOrder {
    const o = this.#orders.get(id);
    if (o === undefined) throw new Error(`no fake order ${id}`);
    return o;
  }

  /** PayPal finishes a capture it was still completing. */
  finishCapture(id: string): void {
    const o = this.order(id);
    o.completing = false;
    o.captured = true;
  }

  /** The buyer approves at checkout. */
  approve(id: string): void {
    this.order(id).approved = true;
  }
}

export async function resetCheckoutFixtures(): Promise<void> {
  await prisma.$executeRaw`TRUNCATE ledger_entry, idempotency_record, approval RESTART IDENTITY`;
  await prisma.$executeRaw`DELETE FROM catalog_item WHERE merchant_id = ${MERCHANT}`;
  await prisma.merchant.upsert({
    where: { merchantId: MERCHANT },
    create: { merchantId: MERCHANT, rail: "paypal", currency: "USD" },
    update: { rail: "paypal", currency: "USD" },
  });
  await prisma.catalogItem.create({
    data: { merchantId: MERCHANT, sku: SKU, title: "t", description: "d", category: "food", currency: "USD", priceMinor: PRICE, stockQty: 10 },
  });
}

export function buildUsdMandate(mandateId: string) {
  const { privateKeyPem, publicKeyPem } = generateKeypair();
  const doc: MandateDocument = {
    mandate_id: mandateId,
    version: 2,
    issuer_id: "usr_t",
    subject_id: "agt_t",
    scope: { merchant_ids: [MERCHANT], categories: ["food"], currency: "USD" },
    limits: { max_per_txn_minor: "80000", max_total_minor: "500000", max_txns_per_window: 5, window_seconds: 3600, max_denials_per_window: 5 },
    step_up: { threshold_minor: "50000" },
    validity: { not_before: "2026-08-28T00:00:00.000Z", not_after: "2026-12-31T00:00:00.000Z" },
    nonce: "n1",
  };
  return { signed: signMandate(doc, privateKeyPem, "k1"), publicKeyPem };
}

/** Prior history, so the first-merchant step-up doesn't stop the purchase. 1000 minor units, captured. */
export async function seedPriorHistory(mandateId: string): Promise<void> {
  await prisma.$transaction((tx) =>
    append(tx, {
      traceId: "trc_seed",
      ts: new Date("2026-08-28T00:00:00.000Z"),
      actor: "praman",
      eventType: "outcome",
      payload: { mandate_id: mandateId, status: "captured", order_id: "order_SEED", payment_id: "pay_SEED", amount_minor: "1000", currency: "USD", merchant_id: MERCHANT, idempotency_key: "seed" },
    }),
  );
}

export function intentFor(mandateId: string, intentId: string): PurchaseIntent {
  return {
    intent_id: intentId,
    mandate_id: mandateId,
    merchant_id: MERCHANT,
    line_items: [{ sku: SKU, qty: 1 }],
    requested_at: T0.toISOString(),
    agent_rationale: "test",
  };
}

/** Runs a real purchase through runIntent and returns its trace, order and key. */
export async function placeOrder(
  executor: CheckoutExecutor,
  setup: { readonly signed: ReturnType<typeof buildUsdMandate>["signed"]; readonly publicKeyPem: string; readonly mandateId: string },
  intentId: string,
  now: Date = T0,
): Promise<{ traceId: string; orderId: string; key: string }> {
  const result = await runIntent(intentFor(setup.mandateId, intentId), setup.signed, setup.publicKeyPem, routeByRail([executor]), now, "test-model");
  if (result.kind !== "DECIDED" || result.order_id === null) throw new Error(`placeOrder: ${JSON.stringify(result, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))}`);
  const record = await prisma.idempotencyRecord.findFirstOrThrow({ where: { traceId: result.trace_id, kind: "order" } });
  expect(result.order_status === "created" || result.order_status === "mismatch").toBe(true);
  return { traceId: result.trace_id, orderId: result.order_id, key: record.key };
}

/** The ledger's outcome rows on one key, oldest first. */
export async function outcomesFor(key: string): Promise<Record<string, unknown>[]> {
  const rows = await prisma.ledgerEntry.findMany({ where: { eventType: "outcome", payload: { path: ["idempotency_key"], equals: key } }, orderBy: { seq: "asc" } });
  return rows.map((r) => {
    const p = r.payload;
    if (p === null || typeof p !== "object" || Array.isArray(p)) throw new Error("payload is not an object");
    return p;
  });
}
