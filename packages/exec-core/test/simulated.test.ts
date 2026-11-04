import { describe, expect, it } from "vitest";
import { minor, type Minor } from "@praman/shared";
import { SimulatedExecutor } from "../src/simulated.js";

const create = (amount: Minor, receipt: string) => ({ amount_minor: amount, currency: "INR" as const, idempotency_key: `key_${receipt}`, receipt });
const lookup = (receipt: string) => ({ receipt, idempotency_key: `key_${receipt}`, order_id: null, amount_minor: minor(48000n), currency: "INR" as const });

describe("SimulatedExecutor", () => {
  it("creates a captured order by default", async () => {
    const executor = new SimulatedExecutor();
    const outcome = await executor.createOrder(create(minor(48000n), "rcpt_1"));
    expect(outcome.status).toBe("captured");
    expect(outcome.amount_minor).toBe(48000n);
    expect(outcome.payment_id).not.toBeNull();
    expect(outcome.failure_code).toBeNull();
  });

  it("'declined' mode fails the order with a failure code", async () => {
    const executor = new SimulatedExecutor("declined");
    const outcome = await executor.createOrder(create(minor(48000n), "rcpt_1"));
    expect(outcome.status).toBe("failed");
    expect(outcome.payment_id).toBeNull();
    expect(outcome.failure_code).toBe("BAD_REQUEST_ERROR");
  });

  it("'timeout' mode throws instead of returning", async () => {
    const executor = new SimulatedExecutor("timeout");
    await expect(executor.createOrder(create(minor(48000n), "rcpt_1"))).rejects.toThrow("ETIMEDOUT");
  });

  it("calling createOrder twice with the same receipt returns the cached order, not a duplicate", async () => {
    const executor = new SimulatedExecutor();
    const first = await executor.createOrder(create(minor(48000n), "rcpt_1"));
    const second = await executor.createOrder(create(minor(48000n), "rcpt_1"));
    expect(second.order_id).toBe(first.order_id);
  });

  it("findOrder returns null for an unknown receipt", async () => {
    const executor = new SimulatedExecutor();
    expect(await executor.findOrder(lookup("nonexistent"))).toBeNull();
  });

  it("findOrder returns the order once created", async () => {
    const executor = new SimulatedExecutor();
    const created = await executor.createOrder(create(minor(48000n), "rcpt_1"));
    const found = await executor.findOrder(lookup("rcpt_1"));
    expect(found).toEqual(created);
  });

  it("order IDs are sequential and unique across calls", async () => {
    const executor = new SimulatedExecutor();
    const a = await executor.createOrder(create(minor(1000n), "rcpt_a"));
    const b = await executor.createOrder(create(minor(1000n), "rcpt_b"));
    expect(a.order_id).not.toBe(b.order_id);
    expect(a.order_id).toBe("order_SIM00000001");
    expect(b.order_id).toBe("order_SIM00000002");
  });

  it("capture returns the given order id, amount, currency and a captured status", async () => {
    const executor = new SimulatedExecutor();
    const outcome = await executor.capture({ order_id: "order_x", amount_minor: minor(48000n), currency: "USD", idempotency_key: "key_x" });
    expect(outcome.status).toBe("captured");
    expect(outcome.order_id).toBe("order_x");
    expect(outcome.payment_id).not.toBeNull();
    expect(outcome.amount_minor).toBe(48000n);
    expect(outcome.currency).toBe("USD");
  });

  it("labels itself as the simulated rail and reports the requested currency", async () => {
    const executor = new SimulatedExecutor();
    const outcome = await executor.createOrder({ ...create(minor(1250n), "rcpt_usd"), currency: "USD" });
    expect(executor.rail).toBe("simulated");
    expect(outcome).toMatchObject({ rail: "simulated", currency: "USD", approve_url: null });
  });
});
