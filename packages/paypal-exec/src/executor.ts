import type { CaptureRequest, CreateOrderRequest, ExecOutcome, Executor, OrderLookup } from "@praman/exec-core";
import { isCurrency, type Currency, type Minor } from "@praman/shared";
import { describePayPalFailure, isRecord, PayPalClient, PayPalUnknownOutcome, type PayPalConfig, type PayPalResponse } from "./client.js";
import { fromPayPalValue, toPayPalValue } from "./money.js";

export const PAYPAL_SANDBOX_BASE_URL = "https://api-m.sandbox.paypal.com";

/** PayPal's definite answer to a capture before the buyer approved (D-26). A failure of that capture, not of the order. */
export const ORDER_NOT_APPROVED = "ORDER_NOT_APPROVED";

/** 108 works and 109 gets a 500, which would read as an unknown outcome for ever (D-26). Derived keys are 64. */
const MAX_REQUEST_ID_LENGTH = 108;

/**
 * 422s on capture that aren't refusals of the money (D-39). PayPal's error reference
 * says one was already captured, or that PayPal is capturing it now. Calling any of them
 * a failure would close the record while the buyer is, or soon will be, charged.
 */
const CAPTURE_MAY_HAVE_MOVED_MONEY: readonly string[] = ["ORDER_ALREADY_CAPTURED", "ORDER_COMPLETION_IN_PROGRESS", "AUTO_CAPTURE_ENABLED"];

const fitsPayPal = (key: string): boolean => key.length > 0 && key.length <= MAX_REQUEST_ID_LENGTH;

export function requireSandbox(baseUrl: string): void {
  let url: URL | null = null;
  try {
    url = new URL(baseUrl);
  } catch {
    url = null;
  }
  if (url === null || url.protocol !== "https:" || !url.hostname.endsWith(".sandbox.paypal.com")) {
    throw new Error("PayPalExecutor runs against the PayPal sandbox only, and live keys are out of scope for this repo");
  }
}

function unknown(detail: string): PayPalUnknownOutcome {
  return new PayPalUnknownOutcome(`PayPal: ${detail}`);
}

function readMoney(amount: unknown): { amount_minor: Minor; currency: Currency } {
  if (!isRecord(amount)) throw unknown("response has no amount");
  const currency = amount["currency_code"];
  // Another supported currency is reported, and acceptOutcome turns it into a mismatch. One
  // that Praman can't name can't be reported, so the record stays pending.
  if (!isCurrency(currency)) throw unknown("response has an unusable currency");
  try {
    return { amount_minor: fromPayPalValue(amount["value"]), currency };
  } catch {
    throw unknown("response has an unusable amount");
  }
}

/** The buyer is sent here, and the link is PayPal's text, so only a PayPal page over https passes. */
function approveUrl(links: unknown): string | null {
  if (!Array.isArray(links)) return null;
  for (const rel of ["payer-action", "approve"]) {
    const link: unknown = links.find((l: unknown) => isRecord(l) && l["rel"] === rel);
    if (!isRecord(link) || typeof link["href"] !== "string") continue;
    try {
      const url = new URL(link["href"]);
      if (url.protocol === "https:" && url.hostname.endsWith(".paypal.com")) return url.href;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Where PayPal sends the buyer after its checkout page. Server configuration, never
 * from a request: a buyer is redirected there.
 */
export interface CheckoutReturn {
  readonly returnUrl: string;
  readonly cancelUrl: string;
}

export interface PayPalExecutorConfig extends PayPalConfig {
  /** Unset, PayPal shows its own page after approval and the buyer comes back by hand. */
  readonly checkoutReturn?: CheckoutReturn;
}

/** A rail that can also charge a payment method the buyer saved earlier, with no buyer present. */
export interface SavedMethodCharger extends Executor {
  chargeSavedMethod(req: CreateOrderRequest, vaultId: string): Promise<ExecOutcome>;
}

export class PayPalExecutor implements SavedMethodCharger {
  readonly rail = "paypal";
  readonly #client: PayPalClient;
  readonly #checkoutReturn: CheckoutReturn | null;

  constructor(config: PayPalExecutorConfig) {
    requireSandbox(config.baseUrl);
    this.#client = new PayPalClient(config);
    this.#checkoutReturn = config.checkoutReturn ?? null;
  }

  #failed(req: { amount_minor: Minor; currency: Currency }, orderId: string, code: string): ExecOutcome {
    return {
      rail: this.rail,
      order_id: orderId,
      status: "failed",
      amount_minor: req.amount_minor,
      currency: req.currency,
      payment_id: null,
      approve_url: null,
      failure_code: code,
    };
  }

  /**
   * Reports what PayPal said, not what was asked (D-33). Status for status:
   *
   *   CREATED, PAYER_ACTION_REQUIRED, APPROVED   created: an order with no payment yet
   *   VOIDED                                     failed: nothing can be paid on it
   *   COMPLETED                                  whatever its one capture says
   *   anything else                              unknown
   *
   * COMPLETED alone is not enough: PayPal documents a capture inside it as PENDING,
   * DECLINED or FAILED. PENDING is neither money moved nor refused, so it stays unknown
   * until a later look can tell.
   */
  #readOrder(body: Record<string, unknown>): ExecOutcome {
    const orderId = body["id"];
    if (typeof orderId !== "string" || orderId === "") throw unknown("response has no order id");
    const units = body["purchase_units"];
    if (!Array.isArray(units) || units.length !== 1) throw unknown("response does not have exactly one purchase unit");
    const unit: unknown = units[0];
    if (!isRecord(unit)) throw unknown("response has an unusable purchase unit");

    const status = body["status"];
    if (status === "CREATED" || status === "PAYER_ACTION_REQUIRED" || status === "APPROVED") {
      return { rail: this.rail, order_id: orderId, status: "created", ...readMoney(unit["amount"]), payment_id: null, approve_url: approveUrl(body["links"]), failure_code: null };
    }
    if (status === "VOIDED") return this.#failed(readMoney(unit["amount"]), orderId, "PAYPAL_ORDER_VOIDED");
    if (status !== "COMPLETED") throw unknown("response has an unrecognised order status");

    const payments = unit["payments"];
    const captures = isRecord(payments) ? payments["captures"] : undefined;
    if (!Array.isArray(captures) || captures.length !== 1) throw unknown("completed order does not have exactly one capture");
    const capture: unknown = captures[0];
    if (!isRecord(capture)) throw unknown("response has an unusable capture");

    switch (capture["status"]) {
      case "COMPLETED":
      case "PARTIALLY_REFUNDED":
      case "REFUNDED": {
        const paymentId = capture["id"];
        if (typeof paymentId !== "string" || paymentId === "") throw unknown("capture has no id");
        return { rail: this.rail, order_id: orderId, status: "captured", ...readMoney(capture["amount"]), payment_id: paymentId, approve_url: null, failure_code: null };
      }
      case "DECLINED":
        return this.#failed(readMoney(capture["amount"]), orderId, "PAYPAL_CAPTURE_DECLINED");
      case "FAILED":
        return this.#failed(readMoney(capture["amount"]), orderId, "PAYPAL_CAPTURE_FAILED");
      case "PENDING":
        throw unknown("capture is pending at PayPal");
      default:
        throw unknown("capture has an unrecognised status");
    }
  }

  /** An order Praman already named, so an answer about any other is not an answer. */
  #readOrderNamed(body: Record<string, unknown>, orderId: string): ExecOutcome {
    if (body["id"] !== orderId) throw unknown("response is about a different order");
    return this.#readOrder(body);
  }

  #postOrder(req: Pick<CreateOrderRequest, "amount_minor" | "currency" | "idempotency_key" | "receipt">): Promise<PayPalResponse> {
    return this.#client.call("POST", "/v2/checkout/orders", {
      requestId: req.idempotency_key,
      body: {
        intent: "CAPTURE",
        purchase_units: [
          {
            reference_id: req.receipt,
            invoice_id: req.receipt,
            amount: { currency_code: req.currency, value: toPayPalValue(req.amount_minor) },
          },
        ],
        // No shipping step at PayPal, and PAY_NOW because the server captures straight after approval.
        payment_source: {
          paypal: {
            experience_context: {
              shipping_preference: "NO_SHIPPING",
              user_action: "PAY_NOW",
              ...(this.#checkoutReturn === null ? {} : { return_url: this.#checkoutReturn.returnUrl, cancel_url: this.#checkoutReturn.cancelUrl }),
            },
          },
        },
      },
    });
  }

  /**
   * A charge with no buyer present: an order paid from a saved payment method, which
   * PayPal captures as it creates it (D-49). Same key, receipt and amount handling as a
   * checkout order, so a repeat with the same key is the same request, and the answer
   * goes through the same reading. A reused key with another amount is answered with
   * the first charge (D-49), which is why the caller compares what comes back (D-33).
   *
   * The vault id is a secret. It goes in this request body and nowhere else: it is not
   * in the outcome, and PayPal's answer is read for its order, amount and capture only.
   */
  async chargeSavedMethod(req: CreateOrderRequest, vaultId: string): Promise<ExecOutcome> {
    if (req.currency !== "USD") return this.#failed(req, "", "CURRENCY_NOT_SUPPORTED");
    if (!fitsPayPal(req.idempotency_key)) return this.#failed(req, "", "IDEMPOTENCY_KEY_INVALID");
    if (vaultId === "") return this.#failed(req, "", "SAVED_METHOD_MISSING");
    const res = await this.#client.call("POST", "/v2/checkout/orders", {
      requestId: req.idempotency_key,
      body: {
        intent: "CAPTURE",
        purchase_units: [{ reference_id: req.receipt, invoice_id: req.receipt, amount: { currency_code: req.currency, value: toPayPalValue(req.amount_minor) } }],
        payment_source: { paypal: { vault_id: vaultId } },
      },
    });
    return res.kind === "ok" ? this.#readOrder(res.body) : this.#failed(req, "", res.code);
  }

  #getOrder(orderId: string): Promise<PayPalResponse> {
    return this.#client.call("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  }

  /**
   * PayPal runs in USD here, and answers INR with 422 CURRENCY_NOT_SUPPORTED
   * (D-26). Refused first, so that a refusal can't depend on PayPal's account
   * settings, which could change.
   */
  async createOrder(req: CreateOrderRequest): Promise<ExecOutcome> {
    if (req.currency !== "USD") return this.#failed(req, "", "CURRENCY_NOT_SUPPORTED");
    if (!fitsPayPal(req.idempotency_key)) return this.#failed(req, "", "IDEMPOTENCY_KEY_INVALID");
    const res = await this.#postOrder(req);
    return res.kind === "ok" ? this.#readOrder(res.body) : this.#failed(req, "", res.code);
  }

  /**
   * With an order id, reads that order. Without one, repeats the create with the
   * same key, because PayPal has no order search (D-26). If the first response was
   * lost this returns the same order. If there never was one it creates a new
   * unapproved one, which moves no money. Key retention is undocumented, so
   * this can also happen after a long gap.
   *
   * The reconciler reads null, or a failure, as "no order exists and nothing is
   * held". So null only comes from PayPal saying so about an id, or from a currency
   * createOrder never sends. A refusal is "I couldn't ask", and throws.
   */
  async findOrder(lookup: OrderLookup): Promise<ExecOutcome | null> {
    if (lookup.order_id !== null) {
      const res = await this.#getOrder(lookup.order_id);
      if (res.kind === "ok") return this.#readOrderNamed(res.body, lookup.order_id);
      if (res.status === 404) return null;
      throw this.#couldNotAsk(res.code);
    }
    if (lookup.currency !== "USD") return null;
    if (!fitsPayPal(lookup.idempotency_key)) throw this.#couldNotAsk("IDEMPOTENCY_KEY_INVALID");
    const res = await this.#postOrder(lookup);
    if (res.kind === "ok") return this.#readOrder(res.body);
    throw this.#couldNotAsk(res.code);
  }

  #couldNotAsk(code: string): PayPalUnknownOutcome {
    const why = describePayPalFailure(code);
    return unknown(`couldn't look up the order, ${code}${why === null ? "" : `. ${why}`}`);
  }

  /**
   * Seen live on 2026-11-08 (D-49): a capture after a buyer approved gave 201 and a
   * capture id, the same key gave the same capture again, and a new key got
   * ORDER_ALREADY_CAPTURED, which this method read back as the one capture on all
   * four captured orders. The unit tests still use PayPal's documented shapes
   * (test/documented-shapes.ts), because a new capture needs a buyer to click
   * through PayPal's checkout and can't run unattended.
   *
   * A named refusal is a failure, on the reading that this capture took no money.
   * The exceptions are CAPTURE_MAY_HAVE_MOVED_MONEY, where the order is read back and
   * what it says is reported. An order with no finished capture yet stays unknown, so
   * the record stays pending and a later look can tell.
   *
   * Anything short of a capture or a refusal stays unknown.
   */
  async capture(req: CaptureRequest): Promise<ExecOutcome> {
    if (req.currency !== "USD") return this.#failed(req, req.order_id, "CURRENCY_NOT_SUPPORTED");
    if (!fitsPayPal(req.idempotency_key)) return this.#failed(req, req.order_id, "IDEMPOTENCY_KEY_INVALID");

    const res = await this.#client.call("POST", `/v2/checkout/orders/${encodeURIComponent(req.order_id)}/capture`, { requestId: req.idempotency_key, body: {} });
    if (res.kind === "refused" && !res.issues.some((issue) => CAPTURE_MAY_HAVE_MOVED_MONEY.includes(issue))) return this.#failed(req, req.order_id, res.code);

    const answer = res.kind === "ok" ? res : await this.#getOrder(req.order_id);
    if (answer.kind === "refused") throw this.#couldNotAsk(answer.code);
    const outcome = this.#readOrderNamed(answer.body, req.order_id);
    if (outcome.status === "created") throw unknown("capture answered with an order that isn't captured");
    return outcome;
  }
}
