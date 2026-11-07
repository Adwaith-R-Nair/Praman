import { describe, expect, it, vi } from "vitest";
import { acceptOutcome, type CreateOrderRequest, type ExecOutcome } from "@praman/exec-core";
import { minor, type Minor } from "@praman/shared";
import { PayPalUnknownOutcome } from "../src/client.js";
import { PayPalExecutor, PAYPAL_SANDBOX_BASE_URL, type SavedMethodCharger } from "../src/executor.js";
import { SavedMethodExecutor } from "../src/saved-method.js";
import { PayPalVault } from "../src/vault.js";

const KEY = "c".repeat(64);
const VAULT_ID = "8kk8451t-SECRET-VAULT";
const SECRET = "shh-this-is-the-client-secret";

type Reply = { status: number; body?: unknown; raw?: string } | Error;

function fakePayPal(replies: Reply[]) {
  const api: { url: string; init: RequestInit }[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/v1/oauth2/token")) return new Response(JSON.stringify({ access_token: "A21-token", expires_in: 32400 }), { status: 200 });
    api.push({ url, init });
    const next = replies.shift();
    if (next === undefined) throw new Error(`unexpected call to ${url}`);
    if (next instanceof Error) throw next;
    return new Response(next.status === 204 ? null : (next.raw ?? JSON.stringify(next.body ?? {})), { status: next.status });
  });
  return { fetchMock, api };
}

const config = (fetchMock: typeof fetch) => ({ clientId: "client-id", clientSecret: SECRET, baseUrl: PAYPAL_SANDBOX_BASE_URL, fetch: fetchMock });
const req = (amount: Minor = minor(450n)): CreateOrderRequest => ({ amount_minor: amount, currency: "USD", idempotency_key: KEY, receipt: "rcpt_saved_0001" });
const headersOf = (init: RequestInit) => new Headers(init.headers);
const bodyOf = (init: RequestInit): unknown => JSON.parse(String(init.body));

/**
 * The answer the sandbox gave on 2026-11-08 to an order paid from a vault id: 201, the
 * order COMPLETED with its one capture (D-49). Amount and ids are from that run; the
 * rest of PayPal's body (payer, payment_source attributes, links) is left out.
 */
const capturedOnCreation = (value = "4.50", orderId = "7P102752GT801920K") => ({
  id: orderId,
  status: "COMPLETED",
  purchase_units: [
    {
      reference_id: "rcpt_saved_0001",
      payments: { captures: [{ id: "25V56026HN6569816", status: "COMPLETED", amount: { currency_code: "USD", value } }] },
    },
  ],
});

describe("PayPalExecutor.chargeSavedMethod", () => {
  it("names the saved method by vault id, with the derived key and the receipt as invoice id", async () => {
    const { fetchMock, api } = fakePayPal([{ status: 201, body: capturedOnCreation() }]);
    await new PayPalExecutor(config(fetchMock)).chargeSavedMethod(req(), VAULT_ID);

    expect(api[0]?.url).toBe(`${PAYPAL_SANDBOX_BASE_URL}/v2/checkout/orders`);
    expect(headersOf(api[0]!.init).get("PayPal-Request-Id")).toBe(KEY);
    expect(headersOf(api[0]!.init).get("Prefer")).toBe("return=representation");
    expect(bodyOf(api[0]!.init)).toEqual({
      intent: "CAPTURE",
      purchase_units: [{ reference_id: "rcpt_saved_0001", invoice_id: "rcpt_saved_0001", amount: { currency_code: "USD", value: "4.50" } }],
      payment_source: { paypal: { vault_id: VAULT_ID } },
    });
  });

  it("reports an order PayPal captured as it created it, and never the vault id", async () => {
    const { fetchMock } = fakePayPal([{ status: 201, body: capturedOnCreation() }]);
    const outcome = await new PayPalExecutor(config(fetchMock)).chargeSavedMethod(req(), VAULT_ID);

    expect(outcome).toEqual({
      rail: "paypal",
      order_id: "7P102752GT801920K",
      status: "captured",
      amount_minor: 450n,
      currency: "USD",
      payment_id: "25V56026HN6569816",
      approve_url: null,
      failure_code: null,
    });
    expect(JSON.stringify(outcome, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(VAULT_ID);
  });

  it("reports the old charge when PayPal answers a reused key with it, and acceptOutcome calls it a mismatch", async () => {
    // D-49: the same key with $9.00 instead of $4.00 got 200 and the original $4.00 capture.
    const { fetchMock } = fakePayPal([{ status: 200, body: capturedOnCreation("4.00") }]);
    const raw = await new PayPalExecutor(config(fetchMock)).chargeSavedMethod(req(minor(900n)), VAULT_ID);
    expect(raw.amount_minor).toBe(400n);

    const accepted = acceptOutcome(raw, { amount_minor: minor(900n), currency: "USD" });
    expect(accepted.status).toBe("mismatch");
    expect(accepted.amount_minor).toBe(900n);
    expect(accepted.failure_code).toBe("RAIL_AMOUNT_MISMATCH");
  });

  it("refuses INR, an unusable key or an empty vault id without calling PayPal", async () => {
    const { fetchMock, api } = fakePayPal([]);
    const paypal = new PayPalExecutor(config(fetchMock));
    expect((await paypal.chargeSavedMethod({ ...req(), currency: "INR" }, VAULT_ID)).failure_code).toBe("CURRENCY_NOT_SUPPORTED");
    expect((await paypal.chargeSavedMethod({ ...req(), idempotency_key: "" }, VAULT_ID)).failure_code).toBe("IDEMPOTENCY_KEY_INVALID");
    expect((await paypal.chargeSavedMethod(req(), "")).failure_code).toBe("SAVED_METHOD_MISSING");
    expect(api).toHaveLength(0);
  });

  it("carries PayPal's refusal code, and leaves a network error unknown", async () => {
    const { fetchMock } = fakePayPal([
      { status: 422, body: { name: "UNPROCESSABLE_ENTITY", message: "free text", details: [{ issue: "PAYEE_ACCOUNT_RESTRICTED" }] } },
      new TypeError("fetch failed"),
    ]);
    const paypal = new PayPalExecutor(config(fetchMock));
    const refused = await paypal.chargeSavedMethod(req(), VAULT_ID);
    expect(refused.status).toBe("failed");
    expect(refused.failure_code).toBe("PAYEE_ACCOUNT_RESTRICTED");
    const err = await paypal.chargeSavedMethod(req(), VAULT_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalUnknownOutcome);
    expect(String(err)).not.toContain(VAULT_ID);
  });
});

describe("PayPalExecutor checkout return", () => {
  it("sends the configured return and cancel pages with a checkout order, and nothing when unset", async () => {
    const order = { id: "ORDER1", status: "PAYER_ACTION_REQUIRED", purchase_units: [{ amount: { currency_code: "USD", value: "4.50" } }], links: [] };
    const { fetchMock, api } = fakePayPal([{ status: 200, body: order }, { status: 200, body: order }]);
    await new PayPalExecutor({ ...config(fetchMock), checkoutReturn: { returnUrl: "https://demo.example/r", cancelUrl: "https://demo.example/c" } }).createOrder(req());
    await new PayPalExecutor(config(fetchMock)).createOrder(req());

    const contexts = api.map((a) => (bodyOf(a.init) as { payment_source: { paypal: { experience_context: unknown } } }).payment_source.paypal.experience_context);
    expect(contexts[0]).toEqual({ shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW", return_url: "https://demo.example/r", cancel_url: "https://demo.example/c" });
    expect(contexts[1]).toEqual({ shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW" });
  });
});

/** Records which path each call took, and answers like the rail would. */
class FakeCharger implements SavedMethodCharger {
  readonly rail = "paypal";
  readonly calls: string[] = [];
  #answer(req: CreateOrderRequest, status: ExecOutcome["status"]): ExecOutcome {
    return { rail: "paypal", order_id: "O1", status, amount_minor: req.amount_minor, currency: req.currency, payment_id: null, approve_url: null, failure_code: null };
  }
  async createOrder(r: CreateOrderRequest) {
    this.calls.push("checkout");
    return this.#answer(r, "created");
  }
  async chargeSavedMethod(r: CreateOrderRequest, vaultId: string) {
    this.calls.push(`charge:${vaultId}`);
    return this.#answer(r, "captured");
  }
  async findOrder() {
    this.calls.push("find");
    return null;
  }
  async capture(r: { amount_minor: Minor; currency: "USD" | "INR" }) {
    this.calls.push("capture");
    return { ...this.#answer({ ...req(), ...r }, "captured") };
  }
}

describe("SavedMethodExecutor", () => {
  it("charges the saved method the server chose, and makes a checkout order when it chose none", async () => {
    const inner = new FakeCharger();
    const chosen: (string | null)[] = [VAULT_ID, null];
    const exec = new SavedMethodExecutor(inner, () => chosen.shift() ?? null);

    expect((await exec.createOrder(req())).status).toBe("captured");
    expect((await exec.createOrder(req())).status).toBe("created");
    expect(inner.calls).toEqual([`charge:${VAULT_ID}`, "checkout"]);
    expect(exec.rail).toBe("paypal");
  });

  it("never repeats a charge to look an order up, and captures through the plain rail", async () => {
    const inner = new FakeCharger();
    const exec = new SavedMethodExecutor(inner, () => VAULT_ID);
    await exec.findOrder({ receipt: "r", idempotency_key: KEY, order_id: null, amount_minor: minor(450n), currency: "USD" });
    await exec.capture({ order_id: "O1", amount_minor: minor(450n), currency: "USD", idempotency_key: KEY });
    expect(inner.calls).toEqual(["find", "capture"]);
  });
});

describe("PayPalVault", () => {
  it("asks for a setup token with the server's return pages and returns PayPal's approve link", async () => {
    const { fetchMock, api } = fakePayPal([
      {
        status: 201,
        body: { id: "5C991763VB2771612", status: "PAYER_ACTION_REQUIRED", links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/agreements/approve?approval_session_id=5C991763VB2771612" }] },
      },
    ]);
    const result = await new PayPalVault(config(fetchMock)).createSetupToken({ requestId: KEY, returnUrl: "https://demo.example/back", cancelUrl: "https://demo.example/cancel", brandName: "Praman demo" });

    expect(result).toEqual({ ok: true, value: { id: "5C991763VB2771612", approveUrl: "https://www.sandbox.paypal.com/agreements/approve?approval_session_id=5C991763VB2771612" } });
    expect(api[0]?.url).toBe(`${PAYPAL_SANDBOX_BASE_URL}/v3/vault/setup-tokens`);
    expect(headersOf(api[0]!.init).get("PayPal-Request-Id")).toBe(KEY);
    expect(bodyOf(api[0]!.init)).toEqual({
      payment_source: {
        paypal: {
          usage_type: "MERCHANT",
          experience_context: { return_url: "https://demo.example/back", cancel_url: "https://demo.example/cancel", brand_name: "Praman demo", shipping_preference: "NO_SHIPPING" },
        },
      },
    });
  });

  it("refuses an approve link that isn't a PayPal page", async () => {
    const { fetchMock } = fakePayPal([{ status: 201, body: { id: "5C991763VB2771612", links: [{ rel: "approve", href: "https://evil.example/approve" }] } }]);
    await expect(new PayPalVault(config(fetchMock)).createSetupToken({ requestId: KEY, returnUrl: "x", cancelUrl: "y", brandName: "b" })).rejects.toBeInstanceOf(PayPalUnknownOutcome);
  });

  it("turns an approved setup token into a payment token, and reports a refusal by code", async () => {
    const { fetchMock, api } = fakePayPal([
      { status: 201, body: { id: VAULT_ID, customer: { id: "CUST1" } } },
      { status: 422, body: { name: "UNPROCESSABLE_ENTITY", message: "free text", details: [{ issue: "SETUP_TOKEN_NOT_APPROVED" }] } },
    ]);
    const vault = new PayPalVault(config(fetchMock));
    expect(await vault.createPaymentToken("5C991763VB2771612", KEY)).toEqual({ ok: true, value: { id: VAULT_ID } });
    expect(bodyOf(api[0]!.init)).toEqual({ payment_source: { token: { id: "5C991763VB2771612", type: "SETUP_TOKEN" } } });
    expect(await vault.createPaymentToken("5C991763VB2771612", KEY)).toEqual({ ok: false, code: "SETUP_TOKEN_NOT_APPROVED" });
  });

  it("deletes a payment token with DELETE, and refuses a malformed id without calling", async () => {
    const { fetchMock, api } = fakePayPal([{ status: 204 }]);
    const vault = new PayPalVault(config(fetchMock));
    expect(await vault.deletePaymentToken(VAULT_ID)).toEqual({ ok: true, value: null });
    expect(api[0]?.init.method).toBe("DELETE");
    expect(api[0]?.url).toBe(`${PAYPAL_SANDBOX_BASE_URL}/v3/vault/payment-tokens/${VAULT_ID}`);
    expect(await vault.deletePaymentToken("../orders")).toEqual({ ok: false, code: "PAYMENT_TOKEN_INVALID" });
    expect(api).toHaveLength(1);
  });

  it("won't run against anything but the sandbox", () => {
    expect(() => new PayPalVault({ ...config(fetch), baseUrl: "https://api-m.paypal.com" })).toThrow(/sandbox only/);
  });
});
