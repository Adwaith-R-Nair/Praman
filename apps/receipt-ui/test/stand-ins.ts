import type { ConversationItem, ModelProvider, ProviderTurn, ToolSpec } from "@praman/agent-core";
import type { CaptureRequest, CreateOrderRequest, ExecOutcome, OrderLookup, RefundOutcome, RefundRequest } from "@praman/exec-core";
import type { SavedMethodCharger, SetupToken, VaultResult } from "@praman/paypal-exec";
import type { Minor } from "@praman/shared";
import type { VaultApi } from "../src/demo/connect.js";

// The demo's two outside parties, for the tests and the local browser suite. The model is
// scripted and PayPal answers the way the sandbox did on 2026-11-08 (D-49). No network.

export const PAYMENT_TOKEN = "PAYTOKEN-9f8e7d-NEVER-SHOWN";
export const SETUP_TOKEN = "SETUPTOKEN1";

/** Proposes the cart each step's goal asks for, after reading the catalog once. */
export class ScriptedModel implements ModelProvider {
  readonly id = "test/scripted-demo-model";
  calls = 0;
  fail = false;
  /** When set, proposed instead of what the goal asks for: a model that went its own way. */
  override: Record<string, unknown> | null = null;
  async send(_s: string, history: readonly ConversationItem[], _t: readonly ToolSpec[]): Promise<ProviderTurn> {
    this.calls += 1;
    if (this.fail) throw new Error("model exploded\n    at secretFunction (/srv/app/internal.ts:42:7)");
    const first = history[0];
    const goal = first?.role === "user" ? first.text : "";
    if (history.length === 1) return { kind: "TOOL_CALLS", calls: [{ id: "c1", name: "list_catalog", input: {} }], raw: null };
    const cart = goal.includes("Burrito")
      ? { merchant_id: "DEMO_CAFE", line_items: [{ sku: "SKU_CAFE_BOWL", qty: 1 }] }
      : goal.includes("Iced Coffee")
        ? { merchant_id: "DEMO_CAFE", line_items: [{ sku: "SKU_CAFE_COFFEE", qty: 1 }] }
        : goal.includes("Team Lunch")
          ? { merchant_id: "DEMO_CAFE", line_items: [{ sku: "SKU_CAFE_TRAY", qty: 1 }] }
          : { merchant_id: "DEMO_MARKET", line_items: [{ sku: "SKU_INJ2_DOSA", qty: 1 }, { sku: "SKU_INJ2_COFFEE", qty: 1 }] };
    const input = this.override ?? { ...cart, rationale: "what the goal asked for" };
    return { kind: "TOOL_CALLS", calls: [{ id: "c2", name: "propose_intent", input }], raw: null };
  }
}

interface FakeOrder {
  id: string;
  amount: Minor;
  approved: boolean;
  captured: boolean;
}

/** PayPal as seen on 2026-11-08: a saved-method charge is captured on creation; a checkout order waits for the buyer. */
export class FakePayPal implements SavedMethodCharger, VaultApi {
  readonly rail = "paypal";
  readonly charges: { req: CreateOrderRequest; vaultId: string }[] = [];
  readonly checkouts: CreateOrderRequest[] = [];
  readonly deleted: string[] = [];
  readonly orders = new Map<string, FakeOrder>();
  #n = 0;

  #view(o: FakeOrder): ExecOutcome {
    return {
      rail: "paypal",
      order_id: o.id,
      status: o.captured ? "captured" : "created",
      amount_minor: o.amount,
      currency: "USD",
      payment_id: o.captured ? `CAP_${o.id}` : null,
      approve_url: o.captured ? null : `https://www.sandbox.paypal.com/checkoutnow?token=${o.id}`,
      failure_code: null,
    };
  }
  /** The next saved-method charge gets no answer, as when the network drops after PayPal took it. */
  failNextCharge = false;
  async chargeSavedMethod(req: CreateOrderRequest, vaultId: string): Promise<ExecOutcome> {
    this.charges.push({ req, vaultId });
    if (this.failNextCharge) {
      this.failNextCharge = false;
      throw new Error("ETIMEDOUT");
    }
    const o = { id: `VLT${String(++this.#n)}`, amount: req.amount_minor, approved: true, captured: true };
    this.orders.set(o.id, o);
    return this.#view(o);
  }
  async createOrder(req: CreateOrderRequest): Promise<ExecOutcome> {
    this.checkouts.push(req);
    const o = { id: `CHK${String(++this.#n)}`, amount: req.amount_minor, approved: false, captured: false };
    this.orders.set(o.id, o);
    return this.#view(o);
  }
  async findOrder(lookup: OrderLookup): Promise<ExecOutcome | null> {
    const o = lookup.order_id === null ? undefined : this.orders.get(lookup.order_id);
    return o === undefined ? null : this.#view(o);
  }
  async capture(req: CaptureRequest): Promise<ExecOutcome> {
    const o = this.orders.get(req.order_id);
    if (o === undefined) throw new Error("no such order");
    if (!o.approved) return { ...this.#view(o), status: "failed", approve_url: null, failure_code: "ORDER_NOT_APPROVED" };
    o.captured = true;
    return this.#view(o);
  }
  approveAll(): void {
    for (const o of this.orders.values()) o.approved = true;
  }
  /** Refunds by PayPal-Request-Id: the same key gets the same refund, as on 2026-11-08 (D-68). */
  readonly refunds: RefundRequest[] = [];
  readonly #refundsByKey = new Map<string, RefundOutcome>();
  /** The next refund gets no answer, as when the network drops before PayPal replies. */
  failNextRefund = false;
  async refund(req: RefundRequest): Promise<RefundOutcome> {
    this.refunds.push(req);
    if (this.failNextRefund) {
      this.failNextRefund = false;
      throw new Error("ETIMEDOUT");
    }
    const known = this.#refundsByKey.get(req.idempotency_key);
    if (known !== undefined) return known;
    const done: RefundOutcome = { rail: "paypal", payment_id: req.payment_id, refund_id: `REF${String(this.#refundsByKey.size + 1)}`, status: "refunded", amount_minor: req.amount_minor, currency: req.currency, failure_code: null };
    this.#refundsByKey.set(req.idempotency_key, done);
    return done;
  }
  async createSetupToken(): Promise<VaultResult<SetupToken>> {
    return { ok: true, value: { id: SETUP_TOKEN, approveUrl: `https://www.sandbox.paypal.com/agreements/approve?approval_session_id=${SETUP_TOKEN}` } };
  }
  async createPaymentToken(setupTokenId: string): Promise<VaultResult<{ readonly id: string }>> {
    return setupTokenId === SETUP_TOKEN ? { ok: true, value: { id: PAYMENT_TOKEN } } : { ok: false, code: "INVALID_RESOURCE_ID" };
  }
  async deletePaymentToken(id: string): Promise<VaultResult<null>> {
    this.deleted.push(id);
    return { ok: true, value: null };
  }
}
