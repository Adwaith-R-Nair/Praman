import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@praman/db";
import { deriveState } from "@praman/ledger";
import { routeByRail } from "@praman/exec-core";
import { minor } from "@praman/shared";
import { captureOrder, ORDER_HOLD_TTL_MS } from "../src/capture-order.js";
import { releaseStaleOrders } from "../src/release-orders.js";
import { buildUsdMandate, CheckoutExecutor, MERCHANT, outcomesFor, placeOrder, resetCheckoutFixtures, seedPriorHistory, T0 } from "./support/checkout.js";

beforeEach(async () => {
  await resetCheckoutFixtures();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.$disconnect();
});

const AFTER_WINDOW = new Date(T0.getTime() + ORDER_HOLD_TTL_MS + 1000);
const INSIDE_WINDOW = new Date(T0.getTime() + ORDER_HOLD_TTL_MS - 1000);

async function setup(mandateId: string, executor = new CheckoutExecutor()) {
  await seedPriorHistory(mandateId);
  const { signed, publicKeyPem } = buildUsdMandate(mandateId);
  return { executor, ctx: { signed, publicKeyPem, mandateId }, route: routeByRail([executor]) };
}

const spent = async (mandateId: string) => (await prisma.$transaction((tx) => deriveState(tx, mandateId))).spent_minor;

describe("releaseStaleOrders", () => {
  it("releases an unapproved paypal order after 10 minutes", async () => {
    const { executor, ctx, route } = await setup("mnd_rel_after");
    const order = await placeOrder(executor, ctx, "int_rel_after");
    expect(await spent(ctx.mandateId)).toBe(minor(1000n + 1250n));

    expect(await releaseStaleOrders(route, AFTER_WINDOW)).toBe(1);

    const rows = await outcomesFor(order.key);
    expect(rows.map((p) => p["status"])).toEqual(["created", "released"]);
    expect(rows[1]).toMatchObject({ order_id: order.orderId, idempotency_key: order.key, mandate_id: ctx.mandateId, merchant_id: MERCHANT });
    const state = await prisma.$transaction((tx) => deriveState(tx, ctx.mandateId));
    expect(state.spent_minor).toBe(minor(1000n));
    expect(state.txn_timestamps).toHaveLength(2);
    expect(state.released_keys.has(order.key)).toBe(true);
  });

  it("does not release before 10 minutes", async () => {
    const { executor, ctx, route } = await setup("mnd_rel_before");
    await placeOrder(executor, ctx, "int_rel_before");

    expect(await releaseStaleOrders(route, INSIDE_WINDOW)).toBe(0);
    expect(await spent(ctx.mandateId)).toBe(minor(1000n + 1250n));
  });

  it("releases an order once, however many sweeps run", async () => {
    const { executor, ctx, route } = await setup("mnd_rel_once");
    const order = await placeOrder(executor, ctx, "int_rel_once");

    expect(await releaseStaleOrders(route, AFTER_WINDOW)).toBe(1);
    expect(await releaseStaleOrders(route, AFTER_WINDOW)).toBe(0);
    expect((await outcomesFor(order.key)).filter((p) => p["status"] === "released")).toHaveLength(1);
  });

  it("never releases a razorpay order", async () => {
    await prisma.merchant.update({ where: { merchantId: MERCHANT }, data: { rail: "razorpay" } });
    const { executor, ctx, route } = await setup("mnd_rel_rzp", new CheckoutExecutor("razorpay"));
    const order = await placeOrder(executor, ctx, "int_rel_rzp");

    expect(await releaseStaleOrders(route, AFTER_WINDOW)).toBe(0);
    expect((await outcomesFor(order.key)).map((p) => p["status"])).toEqual(["created"]);
    expect(executor.findCalls).toHaveLength(0);
  });

  it("does not release while a capture record is pending", async () => {
    const { executor, ctx, route } = await setup("mnd_rel_pending");
    const order = await placeOrder(executor, ctx, "int_rel_pending");
    executor.approve(order.orderId);
    executor.captureAnswer = "throw";
    expect((await captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, route, T0)).kind).toBe("IN_FLIGHT");

    expect(await releaseStaleOrders(route, AFTER_WINDOW)).toBe(0);
    expect(await spent(ctx.mandateId)).toBe(minor(1000n + 1250n));
  });

  it("does not release an order the rail says is captured", async () => {
    const { executor, ctx, route } = await setup("mnd_rel_railcap");
    const order = await placeOrder(executor, ctx, "int_rel_railcap");
    executor.order(order.orderId).captured = true;

    expect(await releaseStaleOrders(route, AFTER_WINDOW)).toBe(0);
    expect(await spent(ctx.mandateId)).toBe(minor(1000n + 1250n));
  });

  it("does not release an order it can't ask the rail about", async () => {
    const { executor, ctx, route } = await setup("mnd_rel_noask");
    await placeOrder(executor, ctx, "int_rel_noask");
    executor.findThrows = true;

    expect(await releaseStaleOrders(route, AFTER_WINDOW)).toBe(0);
  });

  it("does not release a captured order", async () => {
    const { executor, ctx, route } = await setup("mnd_rel_captured");
    const order = await placeOrder(executor, ctx, "int_rel_captured");
    executor.approve(order.orderId);
    expect((await captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, route, T0)).kind).toBe("CAPTURED");

    expect(await releaseStaleOrders(route, AFTER_WINDOW)).toBe(0);
  });

  it("releases after a definite capture failure, once the window has passed", async () => {
    const { executor, ctx, route } = await setup("mnd_rel_failed");
    const order = await placeOrder(executor, ctx, "int_rel_failed");
    expect((await captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, route, T0)).kind).toBe("FAILED");

    expect(await releaseStaleOrders(route, INSIDE_WINDOW)).toBe(0);
    expect(await releaseStaleOrders(route, AFTER_WINDOW)).toBe(1);
    expect(await spent(ctx.mandateId)).toBe(minor(1000n));
  });

  it("refuses capture after release with ORDER_RELEASED, and moves no money", async () => {
    const { executor, ctx, route } = await setup("mnd_rel_late");
    const order = await placeOrder(executor, ctx, "int_rel_late");
    expect(await releaseStaleOrders(route, AFTER_WINDOW)).toBe(1);

    // The buyer comes back and approves after the window closed.
    executor.approve(order.orderId);
    const result = await captureOrder(order.traceId, ctx.signed, ctx.publicKeyPem, route, AFTER_WINDOW);

    expect(result).toMatchObject({ kind: "REFUSED", reason_code: "ORDER_RELEASED" });
    expect(executor.captureCalls).toHaveLength(0);
    expect(await spent(ctx.mandateId)).toBe(minor(1000n));
  });
});
