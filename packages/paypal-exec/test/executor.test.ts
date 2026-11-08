import { describe, expect, it, vi } from "vitest";
import { acceptOutcome, acceptRefund, idempotencyKey, type CaptureRequest, type CreateOrderRequest, type RefundRequest } from "@praman/exec-core";
import { minor, type Currency, type Minor } from "@praman/shared";
import { describePayPalFailure, PayPalUnknownOutcome } from "../src/client.js";
import { PayPalExecutor, PAYPAL_SANDBOX_BASE_URL } from "../src/executor.js";
import { documentedCapture, liveRefund } from "./documented-shapes.js";

const KEY = "a".repeat(64);
const SECRET = "shh-this-is-the-client-secret";
const TOKEN = "A21-a-bearer-token";

type Reply = { status: number; body?: unknown; raw?: string } | Error;

/** Answers OAuth with a token, and API calls from a queue, keeping what was sent. */
function fakePayPal(replies: Reply[], tokens: Reply[] = []) {
  const api: { url: string; init: RequestInit }[] = [];
  const oauth: RequestInit[] = [];
  const respond = (r: Reply) => {
    if (r instanceof Error) throw r;
    return new Response(r.raw ?? JSON.stringify(r.body ?? {}), { status: r.status });
  };
  const fetchMock = vi.fn<typeof fetch>(async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/v1/oauth2/token")) {
      oauth.push(init);
      return respond(tokens.shift() ?? { status: 200, body: { access_token: `${TOKEN}-${oauth.length}`, expires_in: 32400 } });
    }
    api.push({ url, init });
    const next = replies.shift();
    if (next === undefined) throw new Error(`unexpected call to ${url}`);
    return respond(next);
  });
  return { fetchMock, api, oauth };
}

function executor(fetchMock: typeof fetch, now?: () => number) {
  return new PayPalExecutor({ clientId: "client-id", clientSecret: SECRET, baseUrl: PAYPAL_SANDBOX_BASE_URL, fetch: fetchMock, ...(now ? { now } : {}) });
}

const createReq = (amount: Minor = minor(1250n), currency: Currency = "USD", key = KEY): CreateOrderRequest => ({
  amount_minor: amount,
  currency,
  idempotency_key: key,
  receipt: "rcpt_0123456789",
});
const captureReq = (key = KEY): CaptureRequest => ({ order_id: "5O190127TN364715T", amount_minor: minor(10000n), currency: "USD", idempotency_key: key });
const lookup = (order_id: string | null = null, currency: Currency = "USD") => ({
  receipt: "rcpt_0123456789",
  idempotency_key: KEY,
  order_id,
  amount_minor: minor(1250n),
  currency,
});

/** The order shape the live sandbox answered with: see live.test.ts. */
const order = (over: Partial<{ id: string; status: string; value: string; currency: string; links: unknown }> = {}) => ({
  id: over.id ?? "ORDER1",
  status: over.status ?? "PAYER_ACTION_REQUIRED",
  purchase_units: [{ reference_id: "rcpt_0123456789", amount: { currency_code: over.currency ?? "USD", value: over.value ?? "12.50" } }],
  links: over.links ?? [
    { href: "https://api-m.sandbox.paypal.com/v2/checkout/orders/ORDER1", rel: "self", method: "GET" },
    { href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1", rel: "payer-action", method: "GET" },
  ],
});
const refusal = (name: string, issue?: string) => ({ name, message: "free text from paypal", debug_id: "abc", ...(issue ? { details: [{ issue, description: "more free text" }] } : {}) });

const headersOf = (init: RequestInit) => new Headers(init.headers);
const bodyOf = (init: RequestInit): unknown => JSON.parse(String(init.body));

describe("PayPalExecutor.createOrder", () => {
  it("sends the derived key as PayPal-Request-Id on create and capture", async () => {
    const { fetchMock, api } = fakePayPal([
      { status: 201, body: order() },
      { status: 201, body: documentedCapture("COMPLETED") },
    ]);
    const paypal = executor(fetchMock);

    await paypal.createOrder(createReq());
    await paypal.capture(captureReq("b".repeat(64)));

    expect(api[0]?.url).toBe(`${PAYPAL_SANDBOX_BASE_URL}/v2/checkout/orders`);
    expect(api[0]?.init.method).toBe("POST");
    expect(headersOf(api[0]!.init).get("PayPal-Request-Id")).toBe(KEY);
    expect(api[1]?.url).toBe(`${PAYPAL_SANDBOX_BASE_URL}/v2/checkout/orders/5O190127TN364715T/capture`);
    expect(headersOf(api[1]!.init).get("PayPal-Request-Id")).toBe("b".repeat(64));
  });

  it("asks for the full order, because the default answer has no amount to compare", async () => {
    const { fetchMock, api } = fakePayPal([{ status: 201, body: order() }]);
    await executor(fetchMock).createOrder(createReq());
    expect(headersOf(api[0]!.init).get("Prefer")).toBe("return=representation");
  });

  it("sets intent CAPTURE, reference and invoice ids from the receipt, and a USD amount", async () => {
    const { fetchMock, api } = fakePayPal([{ status: 201, body: order() }]);
    await executor(fetchMock).createOrder(createReq());
    expect(bodyOf(api[0]!.init)).toEqual({
      intent: "CAPTURE",
      purchase_units: [{ reference_id: "rcpt_0123456789", invoice_id: "rcpt_0123456789", amount: { currency_code: "USD", value: "12.50" } }],
      payment_source: { paypal: { experience_context: { shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW" } } },
    });
  });

  it("reports a new order as created, with no payment yet", async () => {
    const { fetchMock } = fakePayPal([{ status: 201, body: order() }]);
    const outcome = await executor(fetchMock).createOrder(createReq());
    expect(outcome).toEqual({
      rail: "paypal",
      order_id: "ORDER1",
      status: "created",
      amount_minor: 1250n,
      currency: "USD",
      payment_id: null,
      approve_url: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1",
      failure_code: null,
    });
  });

  it("returns approve_url from the payer-action or approve link", async () => {
    const approve = [{ href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1", rel: "approve", method: "GET" }];
    const { fetchMock } = fakePayPal([{ status: 201, body: order({ status: "CREATED", links: approve }) }]);
    const outcome = await executor(fetchMock).createOrder(createReq());
    expect(outcome.approve_url).toBe("https://www.sandbox.paypal.com/checkoutnow?token=ORDER1");
  });

  it.each([
    ["another host", "https://evil.example/checkoutnow?token=ORDER1"],
    ["a lookalike host", "https://www.sandbox.paypal.com.evil.example/checkoutnow"],
    ["plain http", "http://www.sandbox.paypal.com/checkoutnow"],
    ["a script url", "javascript:alert(1)"],
    ["not a url", "not a url"],
  ])("gives a buyer no approve_url when the link is %s", async (_label, href) => {
    const { fetchMock } = fakePayPal([{ status: 201, body: order({ links: [{ href, rel: "payer-action" }] }) }]);
    const outcome = await executor(fetchMock).createOrder(createReq());
    expect(outcome.status).toBe("created");
    expect(outcome.approve_url).toBeNull();
  });

  it("reports the amount and currency PayPal returned, even when they differ from the request", async () => {
    // D-26: a reused key with a new payload gets a 200 and the ORIGINAL order, with no error.
    const { fetchMock } = fakePayPal([{ status: 200, body: order({ value: "20.00" }) }]);
    const outcome = await executor(fetchMock).createOrder(createReq(minor(9900n)));

    expect(outcome.status).toBe("created");
    expect(outcome.amount_minor).toBe(2000n);

    // D-33: the rail reports, and acceptOutcome is what decides. So this must hold budget, not fail.
    const accepted = acceptOutcome(outcome, { amount_minor: minor(9900n), currency: "USD" });
    expect(accepted).toMatchObject({ status: "mismatch", failure_code: "RAIL_AMOUNT_MISMATCH", amount_minor: 9900n, rail_amount_minor: 2000n, approve_url: null });
  });

  it("reports another supported currency the same way", async () => {
    const { fetchMock } = fakePayPal([{ status: 200, body: order({ currency: "INR" }) }]);
    const outcome = await executor(fetchMock).createOrder(createReq());
    expect(outcome).toMatchObject({ status: "created", currency: "INR" });
    expect(acceptOutcome(outcome, { amount_minor: minor(1250n), currency: "USD" })).toMatchObject({ status: "mismatch", failure_code: "RAIL_CURRENCY_MISMATCH" });
  });

  it("refuses INR with a typed failure and never calls PayPal", async () => {
    const { fetchMock } = fakePayPal([]);
    const outcome = await executor(fetchMock).createOrder(createReq(minor(1250n), "INR"));
    expect(outcome).toMatchObject({ status: "failed", failure_code: "CURRENCY_NOT_SUPPORTED", currency: "INR", payment_id: null, approve_url: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("carries PayPal's named refusal as the failure code, without its free text", async () => {
    const { fetchMock } = fakePayPal([{ status: 422, body: refusal("UNPROCESSABLE_ENTITY", "DECIMALS_NOT_SUPPORTED") }]);
    const outcome = await executor(fetchMock).createOrder(createReq());
    expect(outcome).toMatchObject({ status: "failed", failure_code: "DECIMALS_NOT_SUPPORTED", order_id: "" });
    expect(JSON.stringify({ ...outcome, amount_minor: "" })).not.toContain("free text");
  });
});

describe("key limits", () => {
  it("derives keys that fit PayPal's 108 character limit", () => {
    const key = idempotencyKey("mandate_with_a_very_long_id".repeat(10), {
      intent_id: "i".repeat(200),
      mandate_id: "m",
      merchant_id: "x",
      line_items: [{ sku: "s".repeat(200), qty: 1 }],
      requested_at: "2026-11-05T00:00:00.000Z",
      agent_rationale: "",
    });
    expect(key.length).toBe(64);
    expect(key.length).toBeLessThanOrEqual(108);
  });

  it("accepts a key of exactly 108", async () => {
    const { fetchMock } = fakePayPal([{ status: 201, body: order() }]);
    const outcome = await executor(fetchMock).createOrder(createReq(minor(1250n), "USD", "k".repeat(108)));
    expect(outcome.status).toBe("created");
  });

  it.each([
    ["109 characters, which PayPal answers with a 500", "k".repeat(109)],
    ["empty, which would mean no dedupe at all", ""],
  ])("refuses a key of %s before calling", async (_label, key) => {
    const { fetchMock } = fakePayPal([]);
    const paypal = executor(fetchMock);
    expect(await paypal.createOrder(createReq(minor(1250n), "USD", key))).toMatchObject({ status: "failed", failure_code: "IDEMPOTENCY_KEY_INVALID" });
    expect(await paypal.capture(captureReq(key))).toMatchObject({ status: "failed", failure_code: "IDEMPOTENCY_KEY_INVALID" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("OAuth", () => {
  it("sends the credentials only to the token endpoint, and caches the token", async () => {
    const { fetchMock, api, oauth } = fakePayPal([
      { status: 201, body: order() },
      { status: 200, body: order() },
    ]);
    const paypal = executor(fetchMock);
    await paypal.createOrder(createReq());
    await paypal.createOrder(createReq());

    expect(oauth).toHaveLength(1);
    expect(headersOf(oauth[0]!).get("Authorization")).toBe(`Basic ${Buffer.from(`client-id:${SECRET}`).toString("base64")}`);
    expect(String(oauth[0]!.body)).toBe("grant_type=client_credentials");
    for (const call of api) expect(headersOf(call.init).get("Authorization")).toBe(`Bearer ${TOKEN}-1`);
  });

  it("fetches a new token shortly before the old one expires", async () => {
    let clock = 1_000_000;
    const { fetchMock, oauth } = fakePayPal(
      [
        { status: 201, body: order() },
        { status: 200, body: order() },
        { status: 200, body: order() },
      ],
      [{ status: 200, body: { access_token: "first", expires_in: 3600 } }],
    );
    const paypal = executor(fetchMock, () => clock);

    await paypal.createOrder(createReq());
    clock += 3_000_000;
    await paypal.createOrder(createReq());
    expect(oauth).toHaveLength(1);

    clock += 590_000; // 3590s in, inside the margin before a 3600s token runs out
    await paypal.createOrder(createReq());
    expect(oauth).toHaveLength(2);
  });

  it("shares one token fetch between simultaneous calls", async () => {
    const { fetchMock, oauth } = fakePayPal([
      { status: 201, body: order() },
      { status: 200, body: order() },
    ]);
    const paypal = executor(fetchMock);
    await Promise.all([paypal.createOrder(createReq()), paypal.createOrder(createReq())]);
    expect(oauth).toHaveLength(1);
  });

  it("refreshes the OAuth token once on 401 and repeats the call with the same key", async () => {
    const { fetchMock, api, oauth } = fakePayPal([{ status: 401, body: { error: "invalid_token" } }, { status: 201, body: order() }]);
    const outcome = await executor(fetchMock).createOrder(createReq());

    expect(outcome.status).toBe("created");
    expect(oauth).toHaveLength(2);
    expect(api).toHaveLength(2);
    expect(headersOf(api[1]!.init).get("Authorization")).toBe(`Bearer ${TOKEN}-2`);
    expect(headersOf(api[1]!.init).get("PayPal-Request-Id")).toBe(KEY);
  });

  it("refreshes the OAuth token once on 401, then returns a typed failure", async () => {
    const { fetchMock, api, oauth } = fakePayPal([
      { status: 401, body: { error: "invalid_token" } },
      { status: 401, body: { error: "invalid_token" } },
    ]);
    const outcome = await executor(fetchMock).createOrder(createReq());

    expect(outcome).toMatchObject({ status: "failed", failure_code: "PAYPAL_UNAUTHORIZED" });
    expect(oauth).toHaveLength(2);
    expect(api).toHaveLength(2);
  });

  it("returns a typed failure when PayPal refuses the credentials, with no API call", async () => {
    const { fetchMock, api } = fakePayPal([], [{ status: 401, body: { error: "invalid_client" } }]);
    const outcome = await executor(fetchMock).createOrder(createReq());
    expect(outcome).toMatchObject({ status: "failed", failure_code: "PAYPAL_AUTH_FAILED" });
    expect(api).toHaveLength(0);
  });

  it("treats an unusable token response as an unknown outcome", async () => {
    const { fetchMock } = fakePayPal([], [{ status: 200, body: { expires_in: 3600 } }]);
    await expect(executor(fetchMock).createOrder(createReq())).rejects.toBeInstanceOf(PayPalUnknownOutcome);
  });

  it("returns a typed failure on 403 NOT_AUTHORIZED, naming the likely cause", async () => {
    const { fetchMock } = fakePayPal([{ status: 403, body: refusal("NOT_AUTHORIZED") }]);
    const outcome = await executor(fetchMock).createOrder(createReq());

    expect(outcome).toMatchObject({ status: "failed", failure_code: "PAYPAL_NOT_AUTHORIZED" });
    const why = describePayPalFailure("PAYPAL_NOT_AUTHORIZED");
    expect(why).toMatch(/feature/i);
    expect(why).toMatch(/cached token/i);
    expect(why).toMatch(/terminate/i);
  });

  it("drops a token PayPal refused with 403, so the next call fetches again", async () => {
    // Seen in the sandbox: a cached token kept its old scopes after the app's features changed.
    const { fetchMock, oauth } = fakePayPal([{ status: 403, body: refusal("NOT_AUTHORIZED") }, { status: 201, body: order() }]);
    const paypal = executor(fetchMock);
    await paypal.createOrder(createReq());
    await paypal.createOrder(createReq());
    expect(oauth).toHaveLength(2);
  });

  it("never puts a secret or a token in a failure", async () => {
    const cases: Array<[Reply[], Reply[]]> = [
      [[{ status: 500, raw: "oops" }], []],
      [[new Error("ECONNRESET")], []],
      [[], [{ status: 500, raw: "oops" }]],
      [[], [new Error("ECONNRESET")]],
      [[{ status: 403, body: refusal("NOT_AUTHORIZED") }], []],
    ];
    for (const [replies, tokens] of cases) {
      const { fetchMock } = fakePayPal(replies, tokens);
      const seen = await executor(fetchMock).findOrder(lookup()).then(
        (v) => JSON.stringify({ ...v, amount_minor: "" }),
        (e: unknown) => String(e),
      );
      expect(seen).not.toContain(SECRET);
      expect(seen).not.toContain(TOKEN);
      expect(seen).not.toContain(Buffer.from(`client-id:${SECRET}`).toString("base64"));
    }
    expect(JSON.stringify(executor(fakePayPal([]).fetchMock))).not.toContain(SECRET);
  });
});

describe("an unknown outcome stays pending", () => {
  it("surfaces a network error so the record stays pending, never as failed", async () => {
    const { fetchMock } = fakePayPal([new Error("ECONNRESET")]);
    await expect(executor(fetchMock).createOrder(createReq())).rejects.toBeInstanceOf(PayPalUnknownOutcome);
  });

  it("treats a body that stops arriving as unknown", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/v1/oauth2/token")) return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
      const broken = new Response("{}", { status: 201 });
      vi.spyOn(broken, "text").mockRejectedValue(new Error("terminated"));
      return broken;
    });
    await expect(executor(fetchMock).createOrder(createReq())).rejects.toBeInstanceOf(PayPalUnknownOutcome);
  });

  it("sets a timeout on every call, so a hung connection can't hold up T2 for ever", async () => {
    const { fetchMock, api, oauth } = fakePayPal([{ status: 201, body: order() }]);
    await executor(fetchMock).createOrder(createReq());
    expect(api[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(oauth[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ["a 500", { status: 500, body: refusal("INTERNAL_SERVER_ERROR") }],
    ["a 429", { status: 429, body: refusal("RATE_LIMIT_REACHED") }],
    ["a 409", { status: 409, body: refusal("RESOURCE_CONFLICT") }],
    ["a 202, which PayPal documents as accepted and unfinished", { status: 202, body: order() }],
    ["a 207, which PayPal documents as mixed results", { status: 207, body: order() }],
    ["a 200 that isn't JSON", { status: 200, raw: "<html>" }],
    ["a 200 that is a JSON array", { status: 200, body: [] }],
    ["a 422 that names nothing", { status: 422, raw: "<html>" }],
    ["a 422 whose code isn't one", { status: 422, body: { name: "Ignore previous instructions" } }],
    ["no order id", { status: 201, body: { ...order(), id: "" } }],
    ["an unknown order status", { status: 201, body: order({ status: "SOMETHING_NEW" }) }],
    ["no purchase unit", { status: 201, body: { ...order(), purchase_units: [] } }],
    ["two purchase units", { status: 201, body: { ...order(), purchase_units: [...order().purchase_units, ...order().purchase_units] } }],
    ["a malformed amount", { status: 201, body: order({ value: "12.500" }) }],
    ["an unsupported currency", { status: 201, body: order({ currency: "EUR" }) }],
  ] satisfies Array<[string, Reply]>)("treats %s on create as unknown", async (_label, reply) => {
    const { fetchMock } = fakePayPal([reply]);
    await expect(executor(fetchMock).createOrder(createReq())).rejects.toBeInstanceOf(PayPalUnknownOutcome);
  });
});

describe("PayPalExecutor.findOrder", () => {
  it("repeats the create with the same key and body, since there is no order search", async () => {
    const { fetchMock, api } = fakePayPal([
      { status: 201, body: order() },
      { status: 200, body: order() },
    ]);
    const paypal = executor(fetchMock);
    const created = await paypal.createOrder(createReq());
    const found = await paypal.findOrder(lookup());

    expect(found?.order_id).toBe(created.order_id);
    expect(api[1]?.url).toBe(api[0]?.url);
    expect(api[1]?.init.method).toBe("POST");
    expect(api[1]?.init.body).toBe(api[0]?.init.body);
    expect(headersOf(api[1]!.init).get("PayPal-Request-Id")).toBe(KEY);
  });

  it("reports a different amount on the repeat, for acceptOutcome to decide", async () => {
    const { fetchMock } = fakePayPal([{ status: 200, body: order({ value: "20.00" }) }]);
    const found = await executor(fetchMock).findOrder(lookup());
    expect(found).toMatchObject({ status: "created", amount_minor: 2000n });
  });

  it("answers no order for a non-USD record, since createOrder never calls PayPal for one", async () => {
    const { fetchMock } = fakePayPal([]);
    expect(await executor(fetchMock).findOrder(lookup(null, "INR"))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // The reconciler writes "no order exists, nothing held" for a null or a failure.
  // "PayPal wouldn't answer me" is not that, so every refusal here has to throw.
  it.each([
    ["401 twice", [{ status: 401, body: {} }, { status: 401, body: {} }], []],
    ["403 NOT_AUTHORIZED", [{ status: 403, body: refusal("NOT_AUTHORIZED") }], []],
    ["a named 422", [{ status: 422, body: refusal("UNPROCESSABLE_ENTITY", "SOMETHING") }], []],
    ["refused credentials", [], [{ status: 401, body: { error: "invalid_client" } }]],
    ["a 500", [{ status: 500, raw: "oops" }], []],
  ] satisfies Array<[string, Reply[], Reply[]]>)("throws on %s, so a real order can't be marked as never existing", async (_label, replies, tokens) => {
    const { fetchMock } = fakePayPal(replies, tokens);
    await expect(executor(fetchMock).findOrder(lookup())).rejects.toBeInstanceOf(PayPalUnknownOutcome);
  });

  it("names the likely cause when it can't ask because of a 403", async () => {
    const { fetchMock } = fakePayPal([{ status: 403, body: refusal("NOT_AUTHORIZED") }]);
    await expect(executor(fetchMock).findOrder(lookup())).rejects.toThrow(/PAYPAL_NOT_AUTHORIZED.*cached token/);
  });

  it("reads an order by id when the id is known, with no create", async () => {
    const { fetchMock, api } = fakePayPal([{ status: 200, body: order({ status: "APPROVED" }) }]);
    const found = await executor(fetchMock).findOrder(lookup("ORDER1"));
    expect(api[0]?.url).toBe(`${PAYPAL_SANDBOX_BASE_URL}/v2/checkout/orders/ORDER1`);
    expect(api[0]?.init.method).toBe("GET");
    expect(found).toMatchObject({ status: "created", order_id: "ORDER1" });
  });

  it("escapes an order id on its way into the path", async () => {
    const { fetchMock, api } = fakePayPal([{ status: 404, body: refusal("RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID") }]);
    await executor(fetchMock).findOrder(lookup("../../v1/x"));
    expect(api[0]?.url).toBe(`${PAYPAL_SANDBOX_BASE_URL}/v2/checkout/orders/..%2F..%2Fv1%2Fx`);
  });

  it("answers no order when PayPal says that id doesn't exist", async () => {
    const { fetchMock } = fakePayPal([{ status: 404, body: refusal("RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID") }]);
    expect(await executor(fetchMock).findOrder(lookup("ORDER1"))).toBeNull();
  });

  it("finds a capture that happened by order id, even if the capture response was lost", async () => {
    const { fetchMock } = fakePayPal([{ status: 200, body: documentedCapture("COMPLETED") }]);
    const found = await executor(fetchMock).findOrder(lookup("5O190127TN364715T"));
    expect(found).toMatchObject({ status: "captured", payment_id: "3C679366HH908993F", amount_minor: 10000n, approve_url: null });
  });

  it("treats an answer about another order as unknown", async () => {
    const { fetchMock } = fakePayPal([{ status: 200, body: order({ id: "OTHER" }) }]);
    await expect(executor(fetchMock).findOrder(lookup("ORDER1"))).rejects.toBeInstanceOf(PayPalUnknownOutcome);
  });
});

// Against PayPal's documented shapes only. See documented-shapes.ts: live capture is unverified.
describe("PayPalExecutor.capture", () => {
  it("reports a completed capture with the capture's own id and amount", async () => {
    const { fetchMock, api } = fakePayPal([{ status: 201, body: documentedCapture("COMPLETED") }]);
    const outcome = await executor(fetchMock).capture(captureReq());
    expect(outcome).toEqual({
      rail: "paypal",
      order_id: "5O190127TN364715T",
      status: "captured",
      amount_minor: 10000n,
      currency: "USD",
      payment_id: "3C679366HH908993F",
      approve_url: null,
      failure_code: null,
    });
    expect(headersOf(api[0]!.init).get("Prefer")).toBe("return=representation");
  });

  it("gives the same answer to a repeat, which PayPal documents as a 200", async () => {
    const { fetchMock } = fakePayPal([{ status: 200, body: documentedCapture("COMPLETED") }]);
    expect(await executor(fetchMock).capture(captureReq())).toMatchObject({ status: "captured", payment_id: "3C679366HH908993F" });
  });

  it("reports the amount PayPal captured when it differs, for acceptOutcome to decide", async () => {
    const { fetchMock } = fakePayPal([{ status: 201, body: documentedCapture("COMPLETED", "99.00") }]);
    const outcome = await executor(fetchMock).capture(captureReq());
    expect(outcome).toMatchObject({ status: "captured", amount_minor: 9900n });
    expect(acceptOutcome(outcome, { amount_minor: minor(10000n), currency: "USD" }).status).toBe("mismatch");
  });

  it("returns a definite failure for capture before approval, not an unknown outcome", async () => {
    // Seen live in D-26: 422 ORDER_NOT_APPROVED.
    const { fetchMock } = fakePayPal([{ status: 422, body: refusal("UNPROCESSABLE_ENTITY", "ORDER_NOT_APPROVED") }]);
    const outcome = await executor(fetchMock).capture(captureReq());
    expect(outcome).toMatchObject({ status: "failed", failure_code: "ORDER_NOT_APPROVED", order_id: "5O190127TN364715T", payment_id: null });
  });

  it("reads the real capture when PayPal says it already happened, so paid money isn't called failed", async () => {
    const { fetchMock, api } = fakePayPal([
      { status: 422, body: refusal("UNPROCESSABLE_ENTITY", "ORDER_ALREADY_CAPTURED") },
      { status: 200, body: documentedCapture("COMPLETED") },
    ]);
    const outcome = await executor(fetchMock).capture(captureReq());
    expect(outcome).toMatchObject({ status: "captured", payment_id: "3C679366HH908993F" });
    expect(api[1]?.init.method).toBe("GET");
  });

  it("stays unknown if an already captured order can't then be read", async () => {
    const { fetchMock } = fakePayPal([
      { status: 422, body: refusal("UNPROCESSABLE_ENTITY", "ORDER_ALREADY_CAPTURED") },
      { status: 500, raw: "oops" },
    ]);
    await expect(executor(fetchMock).capture(captureReq())).rejects.toBeInstanceOf(PayPalUnknownOutcome);
  });

  // PayPal's error reference, under capture: both are 422s that mean a capture is under way.
  // Neither has been seen live, because nothing has been captured live.
  describe.each(["ORDER_COMPLETION_IN_PROGRESS", "AUTO_CAPTURE_ENABLED"])("a capture answered with %s, where money may be moving", (issue) => {
    const inProgress: Reply = { status: 422, body: refusal("UNPROCESSABLE_ENTITY", issue) };

    it("reports the capture when reading the order shows it finished", async () => {
      const { fetchMock, api } = fakePayPal([inProgress, { status: 200, body: documentedCapture("COMPLETED") }]);
      expect(await executor(fetchMock).capture(captureReq())).toMatchObject({ status: "captured", payment_id: "3C679366HH908993F" });
      expect(api[1]?.init.method).toBe("GET");
    });

    it("stays unknown while the order shows no capture yet, so the record stays pending", async () => {
      const { fetchMock } = fakePayPal([inProgress, { status: 200, body: order({ id: "5O190127TN364715T", status: "APPROVED" }) }]);
      await expect(executor(fetchMock).capture(captureReq())).rejects.toBeInstanceOf(PayPalUnknownOutcome);
    });

    it("stays unknown while the capture inside the order is pending", async () => {
      const { fetchMock } = fakePayPal([inProgress, { status: 200, body: documentedCapture("PENDING") }]);
      await expect(executor(fetchMock).capture(captureReq())).rejects.toBeInstanceOf(PayPalUnknownOutcome);
    });

    it("stays unknown if the order can't then be read", async () => {
      const { fetchMock } = fakePayPal([inProgress, { status: 500, raw: "oops" }]);
      await expect(executor(fetchMock).capture(captureReq())).rejects.toBeInstanceOf(PayPalUnknownOutcome);
    });

    it("stays unknown if PayPal refuses the read as well", async () => {
      const { fetchMock } = fakePayPal([inProgress, { status: 403, body: refusal("NOT_AUTHORIZED", "PERMISSION_DENIED") }]);
      await expect(executor(fetchMock).capture(captureReq())).rejects.toBeInstanceOf(PayPalUnknownOutcome);
    });

    it("spots the code when it isn't the first one PayPal names", async () => {
      const body = { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "TRANSACTION_REFUSED" }, { issue }] };
      const { fetchMock } = fakePayPal([{ status: 422, body }, { status: 200, body: documentedCapture("COMPLETED") }]);
      expect(await executor(fetchMock).capture(captureReq())).toMatchObject({ status: "captured" });
    });
  });

  it("treats PayPal's other in-progress answer, a 409, as unknown too", async () => {
    const { fetchMock } = fakePayPal([{ status: 409, body: refusal("RESOURCE_CONFLICT", "PREVIOUS_REQUEST_IN_PROGRESS") }]);
    await expect(executor(fetchMock).capture(captureReq())).rejects.toBeInstanceOf(PayPalUnknownOutcome);
  });

  it.each(["DECLINED", "FAILED"])("reports a %s capture as failed, even inside a 201", async (status) => {
    const { fetchMock } = fakePayPal([{ status: 201, body: documentedCapture(status) }]);
    const outcome = await executor(fetchMock).capture(captureReq());
    expect(outcome).toMatchObject({ status: "failed", failure_code: `PAYPAL_CAPTURE_${status}`, order_id: "5O190127TN364715T", payment_id: null });
  });

  it("leaves a PENDING capture unknown, because PayPal hasn't credited the funds or refused them", async () => {
    const { fetchMock } = fakePayPal([{ status: 201, body: documentedCapture("PENDING") }]);
    await expect(executor(fetchMock).capture(captureReq())).rejects.toBeInstanceOf(PayPalUnknownOutcome);
  });

  it.each(["PARTIALLY_REFUNDED", "REFUNDED"])("still reports a %s capture as captured, because the payment happened", async (status) => {
    const { fetchMock } = fakePayPal([{ status: 200, body: documentedCapture(status) }]);
    expect(await executor(fetchMock).capture(captureReq())).toMatchObject({ status: "captured" });
  });

  it.each([
    ["a network error", new Error("ECONNRESET")],
    ["a 500", { status: 500, raw: "oops" }],
    ["a 202", { status: 202, body: documentedCapture("COMPLETED") }],
    ["a 207", { status: 207, body: documentedCapture("COMPLETED") }],
    ["a 409", { status: 409, body: refusal("CONFLICT") }],
    ["an order that isn't completed", { status: 201, body: order({ id: "5O190127TN364715T", status: "APPROVED" }) }],
    ["a completed order with no capture", { status: 201, body: order({ id: "5O190127TN364715T", status: "COMPLETED" }) }],
    ["another order's capture", { status: 201, body: documentedCapture("COMPLETED", "100.00", "USD", "OTHER") }],
    ["a capture with no id", { status: 201, body: { ...documentedCapture("COMPLETED"), purchase_units: [{ payments: { captures: [{ status: "COMPLETED", amount: { currency_code: "USD", value: "100.00" } }] } }] } }],
    ["two captures", { status: 201, body: { ...documentedCapture("COMPLETED"), purchase_units: [{ payments: { captures: [documentedCapture("COMPLETED").purchase_units[0]!.payments.captures[0], documentedCapture("COMPLETED").purchase_units[0]!.payments.captures[0]] } }] } }],
  ] satisfies Array<[string, Reply]>)("treats %s on capture as unknown", async (_label, reply) => {
    const { fetchMock } = fakePayPal([reply]);
    await expect(executor(fetchMock).capture(captureReq())).rejects.toBeInstanceOf(PayPalUnknownOutcome);
  });

  it("refuses non-USD before calling", async () => {
    const { fetchMock } = fakePayPal([]);
    const outcome = await executor(fetchMock).capture({ ...captureReq(), currency: "INR" });
    expect(outcome).toMatchObject({ status: "failed", failure_code: "CURRENCY_NOT_SUPPORTED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

const refundReq = (over: Partial<RefundRequest> = {}): RefundRequest => ({ payment_id: "68C05697TX7382946", amount_minor: minor(200n), currency: "USD", idempotency_key: KEY, ...over });

describe("PayPalExecutor.refund", () => {
  it("refunds the stated amount of one capture under the derived key, and reports PayPal's refund", async () => {
    const { fetchMock, api } = fakePayPal([{ status: 201, body: liveRefund() }]);
    const outcome = await executor(fetchMock).refund(refundReq());
    expect(outcome).toEqual({ rail: "paypal", payment_id: "68C05697TX7382946", refund_id: "7DA46548R94559222", status: "refunded", amount_minor: 200n, currency: "USD", failure_code: null });
    expect(api[0]?.url).toBe(`${PAYPAL_SANDBOX_BASE_URL}/v2/payments/captures/68C05697TX7382946/refund`);
    expect(api[0]?.init.method).toBe("POST");
    expect(headersOf(api[0]!.init).get("PayPal-Request-Id")).toBe(KEY);
    expect(headersOf(api[0]!.init).get("Prefer")).toBe("return=representation");
    expect(JSON.parse(String(api[0]?.init.body))).toEqual({ amount: { currency_code: "USD", value: "2.00" } });
  });

  it("gives the same answer to a repeat with the same key, which PayPal answers with a 200", async () => {
    const { fetchMock } = fakePayPal([{ status: 200, body: liveRefund() }]);
    expect(await executor(fetchMock).refund(refundReq())).toMatchObject({ status: "refunded", refund_id: "7DA46548R94559222" });
  });

  it("reports the old refund's amount when a reused key asks for other money, for acceptRefund to catch", async () => {
    // Seen live (D-68): the same key with 1.00 after a 2.00 refund answered 200 and the 2.00 refund.
    const { fetchMock } = fakePayPal([{ status: 200, body: liveRefund() }]);
    const outcome = await executor(fetchMock).refund(refundReq({ amount_minor: minor(100n) }));
    expect(outcome).toMatchObject({ status: "refunded", amount_minor: 200n });
    expect(acceptRefund(outcome, { amount_minor: minor(100n), currency: "USD" }).status).toBe("mismatch");
  });

  it("reports a pending refund as pending, not as money returned", async () => {
    const { fetchMock } = fakePayPal([{ status: 201, body: liveRefund({ status: "PENDING" }) }]);
    expect(await executor(fetchMock).refund(refundReq())).toMatchObject({ status: "pending", refund_id: "7DA46548R94559222" });
  });

  it.each([
    ["CANCELLED", "PAYPAL_REFUND_CANCELLED"],
    ["FAILED", "PAYPAL_REFUND_FAILED"],
  ])("reports a %s refund as failed, keeping PayPal's refund id", async (status, code) => {
    const { fetchMock } = fakePayPal([{ status: 201, body: liveRefund({ status }) }]);
    expect(await executor(fetchMock).refund(refundReq())).toMatchObject({ status: "failed", failure_code: code, refund_id: "7DA46548R94559222", amount_minor: 200n });
  });

  it("returns a definite failure when the capture is already refunded in full", async () => {
    // Seen live (D-68): a new key, or no key at all, after a full refund.
    const { fetchMock } = fakePayPal([{ status: 422, body: refusal("UNPROCESSABLE_ENTITY", "CAPTURE_FULLY_REFUNDED") }]);
    expect(await executor(fetchMock).refund(refundReq())).toEqual({
      rail: "paypal",
      payment_id: "68C05697TX7382946",
      refund_id: null,
      status: "failed",
      amount_minor: 200n,
      currency: "USD",
      failure_code: "CAPTURE_FULLY_REFUNDED",
    });
  });

  it.each([
    { status: 500, raw: "oops" },
    { status: 409, body: refusal("RESOURCE_CONFLICT", "PREVIOUS_REQUEST_IN_PROGRESS") },
    new Error("ECONNRESET"),
  ])("stays unknown when PayPal's answer can't say what happened (%#)", async (reply) => {
    const { fetchMock } = fakePayPal([reply]);
    await expect(executor(fetchMock).refund(refundReq())).rejects.toBeInstanceOf(PayPalUnknownOutcome);
  });

  it("stays unknown when the answer is about another capture, has no id, or an unknown status", async () => {
    for (const body of [
      liveRefund({ capture: "SOMEONE_ELSES_CAPTURE" }),
      { ...liveRefund(), id: "" },
      liveRefund({ status: "ON_HOLD" }),
      liveRefund({ value: "2.0" }),
    ]) {
      const { fetchMock } = fakePayPal([{ status: 201, body }]);
      await expect(executor(fetchMock).refund(refundReq())).rejects.toBeInstanceOf(PayPalUnknownOutcome);
    }
  });

  it("refuses with no call: another currency, a key PayPal can't take, or no capture id", async () => {
    const { fetchMock } = fakePayPal([]);
    const exec = executor(fetchMock);
    expect(await exec.refund(refundReq({ currency: "INR" }))).toMatchObject({ status: "failed", failure_code: "CURRENCY_NOT_SUPPORTED" });
    expect(await exec.refund(refundReq({ idempotency_key: "k".repeat(109) }))).toMatchObject({ status: "failed", failure_code: "IDEMPOTENCY_KEY_INVALID" });
    expect(await exec.refund(refundReq({ payment_id: "" }))).toMatchObject({ status: "failed", failure_code: "PAYMENT_ID_MISSING" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("configuration", () => {
  it.each(["https://api-m.paypal.com", "https://api.paypal.com", "http://api-m.sandbox.paypal.com", "https://sandbox.paypal.com.evil.example", "nonsense"])(
    "refuses to start against %s, because this repo is sandbox only",
    (baseUrl) => {
      expect(() => new PayPalExecutor({ clientId: "c", clientSecret: "s", baseUrl, fetch: vi.fn<typeof fetch>() })).toThrow(/sandbox/i);
    },
  );
});
