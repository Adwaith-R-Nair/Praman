import type { CaptureRequest, CreateOrderRequest, ExecOutcome, Executor, OrderLookup } from "@praman/exec-core";
import { isCurrency, minorFromRazorpay, type Currency, type Minor } from "@praman/shared";

const BASE = "https://api.razorpay.com/v1";

/**
 * Every call gives up after this, reading the body included. Without it Node's
 * default of about 300 s applies, and a reconcile sweep, which may act on a
 * record 60 s old (RECONCILE_MIN_AGE_MS), could find no order yet, write
 * `failed`, and free the budget of an order still being created (D-44). Half
 * the sweep's minimum age leaves room for T1's commit and T2's lock. A timeout
 * rejects, which is an unknown outcome: the record stays pending.
 */
export const RAZORPAY_REQUEST_TIMEOUT_MS = 30_000;

/**
 * bigint → Number for the outbound Razorpay call. minorFromRazorpay (the
 * inbound boundary) checks Number.isSafeInteger for exactly this reason —
 * this is the same check in the outbound direction. Currently unreachable at
 * this project's mandate caps (well under 2^53), but it's a real system
 * boundary and the check is cheap. Compares in bigint space before
 * converting, not after — converting first would lose the precision the
 * check exists to catch.
 */
function toRazorpayAmount(amountMinor: Minor): number {
  if (amountMinor > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`amount_minor exceeds safe integer range for Razorpay: ${amountMinor}`);
  }
  return Number(amountMinor);
}

/** Inbound boundary, same strictness as minorFromRazorpay. A throw leaves the record pending. */
function currencyFromRazorpay(value: unknown): Currency {
  if (!isCurrency(value)) throw new TypeError(`Razorpay returned an unusable currency: ${String(value)}`);
  return value;
}

export class LiveExecutor implements Executor {
  readonly rail = "razorpay";
  readonly #auth: string;
  constructor(keyId: string, keySecret: string) {
    this.#auth = "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");
  }

  async #call(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error(`Razorpay call timed out after ${RAZORPAY_REQUEST_TIMEOUT_MS} ms`)), RAZORPAY_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${BASE}${path}`, {
        ...init,
        signal: abort.signal,
        headers: { "Content-Type": "application/json", Authorization: this.#auth, ...init?.headers },
      });
      const body = (await res.json()) as Record<string, unknown>;
      if (!res.ok) throw new Error(`Razorpay ${res.status}: ${JSON.stringify(body)}`);
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * This account takes INR only. Refused before any call, because sending cents
   * as an INR order would charge ₹12.50 for something priced at $12.50. The
   * idempotency key isn't sent: Razorpay has no such header, and D-22 covers
   * what the receipt does and doesn't guarantee.
   */
  async createOrder(req: CreateOrderRequest): Promise<ExecOutcome> {
    if (req.currency !== "INR") {
      return {
        rail: this.rail,
        order_id: "",
        status: "failed",
        amount_minor: req.amount_minor,
        currency: req.currency,
        payment_id: null,
        approve_url: null,
        failure_code: "CURRENCY_NOT_SUPPORTED",
      };
    }
    const body = await this.#call("/orders", {
      method: "POST",
      body: JSON.stringify({ amount: toRazorpayAmount(req.amount_minor), currency: req.currency, receipt: req.receipt }),
    });
    return {
      rail: this.rail,
      order_id: String(body["id"]),
      status: "created",
      amount_minor: minorFromRazorpay(body["amount"]),
      currency: currencyFromRazorpay(body["currency"]),
      payment_id: null,
      approve_url: null,
      failure_code: null,
    };
  }

  /** Reconcile before any retry: after a timeout we do not know if the order exists. */
  async findOrder(lookup: OrderLookup): Promise<ExecOutcome | null> {
    const body = await this.#call(`/orders?receipt=${encodeURIComponent(lookup.receipt)}`);
    const items = body["items"];
    if (!Array.isArray(items) || items.length === 0) return null;
    const o = items[0] as Record<string, unknown>;
    return {
      rail: this.rail,
      order_id: String(o["id"]),
      status: o["status"] === "paid" ? "captured" : "created",
      amount_minor: minorFromRazorpay(o["amount"]),
      currency: currencyFromRazorpay(o["currency"]),
      payment_id: null,
      approve_url: null,
      failure_code: null,
    };
  }

  /**
   * Razorpay auto-captures (D-17), so Praman never captures here. Its capture
   * endpoint also takes a payment id, which this flow never has. A typed
   * refusal, not a call: nothing reaches this today, and nothing should.
   */
  async capture(req: CaptureRequest): Promise<ExecOutcome> {
    return {
      rail: this.rail,
      order_id: req.order_id,
      status: "failed",
      amount_minor: req.amount_minor,
      currency: req.currency,
      payment_id: null,
      approve_url: null,
      failure_code: "CAPTURE_NOT_SUPPORTED",
    };
  }
}
