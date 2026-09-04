import { describe, expect, it } from "vitest";
import { paise } from "@praman/shared";
import { SimulatedExecutor } from "../src/simulated.js";

describe("SimulatedExecutor", () => {
  it("creates a captured order by default", async () => {
    const executor = new SimulatedExecutor();
    const outcome = await executor.createOrder(paise(48000n), "rcpt_1");
    expect(outcome.status).toBe("captured");
    expect(outcome.amount_paise).toBe(48000n);
    expect(outcome.payment_id).not.toBeNull();
    expect(outcome.failure_code).toBeNull();
  });

  it("'declined' mode fails the order with a failure code", async () => {
    const executor = new SimulatedExecutor("declined");
    const outcome = await executor.createOrder(paise(48000n), "rcpt_1");
    expect(outcome.status).toBe("failed");
    expect(outcome.payment_id).toBeNull();
    expect(outcome.failure_code).toBe("BAD_REQUEST_ERROR");
  });

  it("'timeout' mode throws instead of returning", async () => {
    const executor = new SimulatedExecutor("timeout");
    await expect(executor.createOrder(paise(48000n), "rcpt_1")).rejects.toThrow("ETIMEDOUT");
  });

  it("calling createOrder twice with the same receipt returns the cached order, not a duplicate", async () => {
    const executor = new SimulatedExecutor();
    const first = await executor.createOrder(paise(48000n), "rcpt_1");
    const second = await executor.createOrder(paise(48000n), "rcpt_1");
    expect(second.order_id).toBe(first.order_id);
  });

  it("findByReceipt returns null for an unknown receipt", async () => {
    const executor = new SimulatedExecutor();
    expect(await executor.findByReceipt("nonexistent")).toBeNull();
  });

  it("findByReceipt returns the order once created", async () => {
    const executor = new SimulatedExecutor();
    const created = await executor.createOrder(paise(48000n), "rcpt_1");
    const found = await executor.findByReceipt("rcpt_1");
    expect(found).toEqual(created);
  });

  it("order IDs are sequential and unique across calls", async () => {
    const executor = new SimulatedExecutor();
    const a = await executor.createOrder(paise(1000n), "rcpt_a");
    const b = await executor.createOrder(paise(1000n), "rcpt_b");
    expect(a.order_id).not.toBe(b.order_id);
    expect(a.order_id).toBe("order_SIM00000001");
    expect(b.order_id).toBe("order_SIM00000002");
  });

  it("capture returns the given payment id, amount, and a captured status", async () => {
    const executor = new SimulatedExecutor();
    const outcome = await executor.capture("pay_x", paise(48000n));
    expect(outcome.status).toBe("captured");
    expect(outcome.payment_id).toBe("pay_x");
    expect(outcome.amount_paise).toBe(48000n);
  });
});
