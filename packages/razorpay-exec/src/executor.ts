import { minorFromRazorpay, type Currency, type Minor } from "@praman/shared";

export interface ExecOutcome {
  readonly order_id: string;
  readonly status: "created" | "captured" | "failed";
  readonly amount_minor: Minor;
  readonly payment_id: string | null;
  readonly failure_code: string | null;
}

export interface Executor {
  createOrder(amountMinor: Minor, receipt: string, currency: Currency): Promise<ExecOutcome>;
  findByReceipt(receipt: string): Promise<ExecOutcome | null>;
  capture(paymentId: string, amountMinor: Minor): Promise<ExecOutcome>;
}

const BASE = "https://api.razorpay.com/v1";

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

export class LiveExecutor implements Executor {
  readonly #auth: string;
  constructor(keyId: string, keySecret: string) {
    this.#auth = "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");
  }

  async #call(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: this.#auth, ...init?.headers },
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new Error(`Razorpay ${res.status}: ${JSON.stringify(body)}`);
    return body;
  }

  /**
   * This account takes INR only. Refused before any call, because sending cents
   * as an INR order would charge ₹12.50 for something priced at $12.50.
   */
  async createOrder(amountMinor: Minor, receipt: string, currency: Currency): Promise<ExecOutcome> {
    if (currency !== "INR") {
      return {
        order_id: "",
        status: "failed",
        amount_minor: amountMinor,
        payment_id: null,
        failure_code: "CURRENCY_NOT_SUPPORTED",
      };
    }
    const body = await this.#call("/orders", {
      method: "POST",
      body: JSON.stringify({ amount: toRazorpayAmount(amountMinor), currency, receipt }),
    });
    return {
      order_id: String(body["id"]),
      status: "created",
      amount_minor: minorFromRazorpay(body["amount"]),
      payment_id: null,
      failure_code: null,
    };
  }

  /** Reconcile before any retry: after a timeout we do not know if the order exists. */
  async findByReceipt(receipt: string): Promise<ExecOutcome | null> {
    const body = await this.#call(`/orders?receipt=${encodeURIComponent(receipt)}`);
    const items = body["items"];
    if (!Array.isArray(items) || items.length === 0) return null;
    const o = items[0] as Record<string, unknown>;
    return {
      order_id: String(o["id"]),
      status: o["status"] === "paid" ? "captured" : "created",
      amount_minor: minorFromRazorpay(o["amount"]),
      payment_id: null,
      failure_code: null,
    };
  }

  async capture(paymentId: string, amountMinor: Minor): Promise<ExecOutcome> {
    const body = await this.#call(`/payments/${paymentId}/capture`, {
      method: "POST",
      body: JSON.stringify({ amount: toRazorpayAmount(amountMinor), currency: "INR" }),
    });
    return {
      order_id: String(body["order_id"]),
      status: body["status"] === "captured" ? "captured" : "failed",
      amount_minor: minorFromRazorpay(body["amount"]),
      payment_id: paymentId,
      failure_code: null,
    };
  }
}
