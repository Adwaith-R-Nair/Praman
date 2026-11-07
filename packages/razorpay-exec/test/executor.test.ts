import { afterEach, describe, expect, it, vi } from "vitest";
import { minor, type Currency, type Minor } from "@praman/shared";
import { LiveExecutor, RAZORPAY_REQUEST_TIMEOUT_MS } from "../src/executor.js";

const create = (amount: Minor, receipt: string, currency: Currency) => ({ amount_minor: amount, currency, idempotency_key: "key_1", receipt });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LiveExecutor currency", () => {
  it("refuses USD with a typed failure and never calls Razorpay", async () => {
    // Without this, 1250 cents would be sent as an INR order for ₹12.50.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new LiveExecutor("k", "s").createOrder(create(minor(1250n), "rcpt_usd", "USD"));

    expect(outcome.status).toBe("failed");
    expect(outcome.failure_code).toBe("CURRENCY_NOT_SUPPORTED");
    expect(outcome.payment_id).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates an INR order as before", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: "order_1", amount: 50000, currency: "INR" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new LiveExecutor("k", "s").createOrder(create(minor(50000n), "rcpt_inr", "INR"));

    expect(outcome).toMatchObject({ rail: "razorpay", order_id: "order_1", status: "created", amount_minor: 50000n, currency: "INR", approve_url: null });
    const body: unknown = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({ amount: 50000, currency: "INR", receipt: "rcpt_inr" });
  });

  it("reports the currency Razorpay answered with, not the one it was asked for", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: "order_1", amount: 50000, currency: "USD" }), { status: 200 })));

    const outcome = await new LiveExecutor("k", "s").createOrder(create(minor(50000n), "rcpt_inr", "INR"));

    expect(outcome.currency).toBe("USD");
  });

  it("throws on a response with no usable currency, so the record stays pending", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: "order_1", amount: 50000 }), { status: 200 })));

    await expect(new LiveExecutor("k", "s").createOrder(create(minor(50000n), "rcpt_inr", "INR"))).rejects.toThrow(TypeError);
  });
});

describe("LiveExecutor.findOrder", () => {
  const lookup = { receipt: "rcpt_inr", idempotency_key: "key_1", order_id: null, amount_minor: minor(50000n), currency: "INR" as const };

  it("looks the order up by receipt", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ items: [{ id: "order_1", amount: 50000, currency: "INR", status: "paid" }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new LiveExecutor("k", "s").findOrder(lookup);

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/orders?receipt=rcpt_inr");
    expect(outcome).toMatchObject({ rail: "razorpay", order_id: "order_1", status: "captured", currency: "INR" });
  });

  it("returns null when no order has that receipt", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })));

    expect(await new LiveExecutor("k", "s").findOrder(lookup)).toBeNull();
  });
});

describe("LiveExecutor.capture", () => {
  it("refuses with a typed failure and never calls Razorpay, which auto-captures (D-17)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new LiveExecutor("k", "s").capture({ order_id: "order_1", amount_minor: minor(50000n), currency: "INR", idempotency_key: "key_1" });

    expect(outcome).toMatchObject({ rail: "razorpay", order_id: "order_1", status: "failed", failure_code: "CAPTURE_NOT_SUPPORTED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("LiveExecutor request timeout", () => {
  /** A fetch that never answers, like a hung connection, and gives up only when its signal aborts. */
  const hangingFetch = () =>
    vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives up on a hung create after RAZORPAY_REQUEST_TIMEOUT_MS, so the record is left pending well before a sweep may touch it", async () => {
    // Without a bound, Node's default of about 300 s applies, and a sweep 60 s in
    // can write `failed` for an order still being created, freeing its budget (D-44).
    vi.useFakeTimers();
    vi.stubGlobal("fetch", hangingFetch());

    const call = new LiveExecutor("k", "s").createOrder(create(minor(50000n), "rcpt_inr", "INR"));
    const settled = expect(call).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(RAZORPAY_REQUEST_TIMEOUT_MS);
    await settled;
  });

  it("gives up on a hung lookup too", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", hangingFetch());

    const call = new LiveExecutor("k", "s").findOrder({ receipt: "rcpt_inr", idempotency_key: "key_1", order_id: null, amount_minor: minor(50000n), currency: "INR" });
    const settled = expect(call).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(RAZORPAY_REQUEST_TIMEOUT_MS);
    await settled;
  });
});
