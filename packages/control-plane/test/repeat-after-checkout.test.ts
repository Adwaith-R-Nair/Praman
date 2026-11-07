import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@praman/db";
import { deriveState } from "@praman/ledger";
import { routeByRail } from "@praman/exec-core";
import { captureOrder, ORDER_HOLD_TTL_MS } from "../src/capture-order.js";
import { releaseStaleOrders } from "../src/release-orders.js";
import { resolveApproval } from "../src/resolve-approval.js";
import { runIntent } from "../src/run-intent.js";
import { buildUsdMandate, CheckoutExecutor, intentFor, outcomesFor, placeOrder, resetCheckoutFixtures, seedPriorHistory, T0 } from "./support/checkout.js";

beforeEach(async () => {
  await resetCheckoutFixtures();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await prisma.$disconnect();
});

const AFTER_WINDOW = new Date(T0.getTime() + ORDER_HOLD_TTL_MS + 1000);

describe("a repeat of an intent whose checkout moved on", () => {
  it("runIntent answers a repeat of a released intent with DUPLICATE_INTENT, not the dead order", async () => {
    const mandateId = "mnd_rep_released";
    await seedPriorHistory(mandateId);
    const { signed, publicKeyPem } = buildUsdMandate(mandateId);
    const executor = new CheckoutExecutor();
    const route = routeByRail([executor]);
    const order = await placeOrder(executor, { signed, publicKeyPem, mandateId }, "int_rep_released");
    expect(await releaseStaleOrders(route, AFTER_WINDOW)).toBe(1);

    const repeat = await runIntent(intentFor(mandateId, "int_rep_released"), signed, publicKeyPem, route, AFTER_WINDOW, "test-model");

    expect(repeat).toMatchObject({
      kind: "DECIDED",
      trace_id: order.traceId,
      agent_visible: { kind: "DENY", reason_code: "DUPLICATE_INTENT" },
      internal_reason_code: "DUPLICATE_INTENT",
      order_status: null,
      approve_url: null,
    });
    // The refusal is on the ledger, like any DUPLICATE_INTENT, and no new order was asked for.
    const denials = await prisma.ledgerEntry.findMany({ where: { traceId: order.traceId, eventType: "decision", payload: { path: ["reason_code"], equals: "DUPLICATE_INTENT" } } });
    expect(denials).toHaveLength(1);
    expect((await outcomesFor(order.key)).map((p) => p["status"])).toEqual(["created", "released"]);
    const state = await prisma.$transaction((tx) => deriveState(tx, mandateId));
    expect(state.denied_attempts).toHaveLength(1);
  });

  it("runIntent reports a captured order as captured, with nowhere to send the buyer", async () => {
    const mandateId = "mnd_rep_captured";
    await seedPriorHistory(mandateId);
    const { signed, publicKeyPem } = buildUsdMandate(mandateId);
    const executor = new CheckoutExecutor();
    const route = routeByRail([executor]);
    const order = await placeOrder(executor, { signed, publicKeyPem, mandateId }, "int_rep_captured");
    executor.approve(order.orderId);
    expect((await captureOrder(order.traceId, signed, publicKeyPem, route, T0)).kind).toBe("CAPTURED");

    const repeat = await runIntent(intentFor(mandateId, "int_rep_captured"), signed, publicKeyPem, route, T0, "test-model");

    expect(repeat).toMatchObject({ kind: "DECIDED", agent_visible: { kind: "ALLOW" }, order_id: order.orderId, order_status: "captured", approve_url: null });
  });

  it("resolveApproval refuses a second approve of a released order instead of resending its checkout", async () => {
    // No prior history, so the first purchase at this merchant steps up.
    const mandateId = "mnd_rep_approval";
    const { signed, publicKeyPem } = buildUsdMandate(mandateId);
    const executor = new CheckoutExecutor();
    const route = routeByRail([executor]);
    // Real time: an approval's age is measured from Postgres's own created_at.
    const now = new Date();
    const later = new Date(now.getTime() + ORDER_HOLD_TTL_MS + 1000);
    const stepUp = await runIntent(intentFor(mandateId, "int_rep_approval"), signed, publicKeyPem, route, now, "test-model");
    if (stepUp.kind !== "DECIDED" || stepUp.approval_id === null) throw new Error("expected a step-up");
    const approved = await resolveApproval(stepUp.approval_id, "approve", signed, publicKeyPem, route, now);
    expect(approved).toMatchObject({ kind: "EXECUTED", order_status: "created" });
    expect(await releaseStaleOrders(route, later)).toBe(1);

    const again = await resolveApproval(stepUp.approval_id, "approve", signed, publicKeyPem, route, later);

    expect(again).toMatchObject({ kind: "REFUSED", reason_code: "DUPLICATE_INTENT" });
    expect(executor.captureCalls).toHaveLength(0);
  });
});
