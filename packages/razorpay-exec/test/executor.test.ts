import { afterEach, describe, expect, it, vi } from "vitest";
import { minor } from "@praman/shared";
import { LiveExecutor } from "../src/executor.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LiveExecutor currency", () => {
  it("refuses USD with a typed failure and never calls Razorpay", async () => {
    // Without this, 1250 cents would be sent as an INR order for ₹12.50.
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new LiveExecutor("k", "s").createOrder(minor(1250n), "rcpt_usd", "USD");

    expect(outcome.status).toBe("failed");
    expect(outcome.failure_code).toBe("CURRENCY_NOT_SUPPORTED");
    expect(outcome.payment_id).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates an INR order as before", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: "order_1", amount: 50000 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await new LiveExecutor("k", "s").createOrder(minor(50000n), "rcpt_inr", "INR");

    expect(outcome).toMatchObject({ order_id: "order_1", status: "created", amount_minor: 50000n });
    const body: unknown = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({ amount: 50000, currency: "INR", receipt: "rcpt_inr" });
  });
});
