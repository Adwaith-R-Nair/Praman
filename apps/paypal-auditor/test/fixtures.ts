import type { EventType, LedgerEntryRecord } from "@praman/ledger";
import type { PayPalReader, ToolAnswer } from "../src/read-only-toolkit.js";

export const TRACE = "trc_audit_test";
export const ORDER = "5MW43748XP341760A";
export const CAPTURE = "1DA33593DL077134A";
export const REFUND = "90W33293UC2395338";
export const KEY = "k".repeat(64);

/** One ledger row before it is given a sequence number. */
export interface Entry {
  readonly eventType: EventType;
  readonly payload: Record<string, unknown>;
}

/** Ledger rows as read() returns them. Hashes are not read by the auditor. */
export function rows(...entries: readonly Entry[]): LedgerEntryRecord[] {
  return entries.map((entry, i) => ({
    seq: BigInt(i + 1),
    traceId: TRACE,
    ts: new Date(Date.UTC(2026, 10, 9, 10, 0, i)),
    actor: "praman",
    eventType: entry.eventType,
    payload: entry.payload,
    payloadHash: "",
    prevHash: "",
    entryHash: "",
  }));
}

const where = { mandate_id: "mnd_test", merchant_id: "DEMO_SHOP", idempotency_key: KEY };

/** The outcome row T2, a capture or the reconciler writes (outcomeFields in exec-core). */
export function outcome(status: string, over: Record<string, unknown> = {}): Entry {
  return {
    eventType: "outcome",
    payload: { ...where, rail: "paypal", status, order_id: ORDER, payment_id: status === "captured" ? CAPTURE : null, failure_code: null, amount_minor: "3200", currency: "USD", ...over },
  };
}

/** The row release-orders.ts writes: no amount. */
export const released: Entry = { eventType: "outcome", payload: { ...where, rail: "paypal", status: "released", order_id: ORDER, currency: "USD", detail: "not approved within 10 minutes" } };

export function refundRequested(refundKey = "rk1"): Entry {
  return { eventType: "refund_requested", payload: { ...where, order_id: ORDER, payment_id: CAPTURE, refund_key: refundKey, rail: "paypal", amount_minor: "3200", currency: "USD", status: "attempted" } };
}

export function refundOutcome(status: string, over: Record<string, unknown> = {}): Entry {
  return {
    eventType: "refund_outcome",
    payload: { ...where, rail: "paypal", status, payment_id: CAPTURE, refund_id: status === "failed" ? null : REFUND, failure_code: null, amount_minor: "3200", currency: "USD", order_id: ORDER, refund_key: "rk1", ...over },
  };
}

export const intent: Entry = { eventType: "intent", payload: { ...where, agent_rationale: "a kettle" } };
export const denied: Entry = { eventType: "decision", payload: { mandate_id: "mnd_test", kind: "DENY", reason_code: "BUDGET_EXCEEDED" } };

const amount = (value: string, currency = "USD"): Record<string, unknown> => ({ currency_code: currency, value });

/** A refund as PayPal returns it, alone or inside an order. Shape seen live on 2026-11-09 through get_refund. */
export function paypalRefund(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: REFUND,
    amount: amount("32.00"),
    status: "COMPLETED",
    links: [
      { href: `https://api.sandbox.paypal.com/v2/payments/refunds/${REFUND}`, rel: "self", method: "GET" },
      { href: `https://api.sandbox.paypal.com/v2/payments/captures/${CAPTURE}`, rel: "up", method: "GET" },
    ],
    ...over,
  };
}

/** A paid order as get_order returned one live on 2026-11-09, with the buyer's details left out. */
export function paidOrder(
  over: {
    readonly value?: string;
    readonly currency?: string;
    readonly captureStatus?: string;
    readonly captureId?: string;
    readonly refunds?: readonly Record<string, unknown>[];
    readonly id?: string;
    readonly status?: string;
    /** Replaces the capture's whole amount object, for values PayPal should never send. */
    readonly captureAmount?: unknown;
    readonly units?: number;
  } = {},
): Record<string, unknown> {
  const money = amount(over.value ?? "32.00", over.currency ?? "USD");
  const unit = {
    reference_id: "7f9b4e49",
    amount: money,
    payments: {
      captures: [{ id: over.captureId ?? CAPTURE, status: over.captureStatus ?? "COMPLETED", amount: over.captureAmount ?? money, final_capture: true }],
      ...(over.refunds === undefined ? {} : { refunds: over.refunds }),
    },
  };
  return { id: over.id ?? ORDER, intent: "CAPTURE", status: over.status ?? "COMPLETED", purchase_units: Array.from({ length: over.units ?? 1 }, () => unit) };
}

/** An order nobody has paid, as get_order returned one live on 2026-11-09. */
export function openOrder(over: { readonly status?: string; readonly value?: string } = {}): Record<string, unknown> {
  return {
    id: ORDER,
    intent: "CAPTURE",
    status: over.status ?? "PAYER_ACTION_REQUIRED",
    payment_source: { paypal: {} },
    purchase_units: [{ reference_id: "8b3998be", amount: { ...amount(over.value ?? "32.00"), breakdown: {} } }],
  };
}

export const ok = (body: Record<string, unknown>): ToolAnswer => ({ kind: "ok", body });
/** The toolkit's error answer for an HTTP status, as seen live for a 404 and a 403. */
export const httpError = (status: number): ToolAnswer => ({ kind: "error", status, code: "PAYPAL_API_HTTP_ERROR" });

export interface FakePayPal extends PayPalReader {
  readonly calls: string[];
}

/** PayPal as a table of answers. Anything not listed answers 404, and every call is recorded. */
export function fakePayPal(answers: { readonly order?: ToolAnswer; readonly refund?: ToolAnswer; readonly disputeList?: ToolAnswer; readonly dispute?: ToolAnswer } = {}): FakePayPal {
  const calls: string[] = [];
  const answer = (call: string, given: ToolAnswer | undefined): Promise<ToolAnswer> => {
    calls.push(call);
    return Promise.resolve(given ?? httpError(404));
  };
  return {
    calls,
    getOrder: (id) => answer(`get_order ${id}`, answers.order),
    getRefund: (id) => answer(`get_refund ${id}`, answers.refund),
    listDisputes: (id) => answer(`list_disputes ${id}`, answers.disputeList ?? ok({ items: [] })),
    getDispute: (id) => answer(`get_dispute ${id}`, answers.dispute),
  };
}
