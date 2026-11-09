import { describe, expect, it } from "vitest";
import { viewTrace } from "../src/ledger-view.js";
import { CAPTURE, denied, type Entry, intent, ORDER, outcome, REFUND, refundOutcome, refundRequested, released, rows } from "./fixtures.js";

function onlyOrder(entries: readonly Entry[]) {
  const trace = viewTrace(rows(...entries));
  if (trace.kind !== "paypal") throw new Error(`expected a PayPal trace, got ${trace.kind}`);
  expect(trace.orders).toHaveLength(1);
  const [order] = trace.orders;
  if (order === undefined) throw new Error("no order");
  return order;
}

describe("viewTrace", () => {
  it("reads a captured order: the capture's amount as bigint, its currency and PayPal's capture id", () => {
    const order = onlyOrder([intent, outcome("created"), outcome("captured")]);
    expect(order).toMatchObject({ orderId: ORDER, status: "captured", amountMinor: 3200n, currency: "USD", captureId: CAPTURE });
    expect(order.refund.state).toBe("none");
  });

  it("reads an unpaid order as created, with no capture id", () => {
    expect(onlyOrder([intent, outcome("created")])).toMatchObject({ status: "created", amountMinor: 3200n, captureId: null });
  });

  it("lets a capture beat a release, whichever row came first", () => {
    expect(onlyOrder([outcome("created"), released, outcome("captured")]).status).toBe("captured");
    expect(onlyOrder([outcome("created"), outcome("captured"), released]).status).toBe("captured");
    expect(onlyOrder([outcome("created"), released]).status).toBe("released");
  });

  it("keeps a failed capture from changing an order that was created", () => {
    expect(onlyOrder([outcome("created"), outcome("failed", { failure_code: "ORDER_NOT_APPROVED" })]).status).toBe("created");
  });

  it("reads a mismatch row as a mismatch, at the amount Praman asked for", () => {
    const order = onlyOrder([outcome("mismatch", { failure_code: "RAIL_AMOUNT_MISMATCH", rail_status: "created", rail_amount_minor: "9900", rail_currency: "USD" })]);
    expect(order).toMatchObject({ status: "mismatch", amountMinor: 3200n });
  });

  it("gives no amount when the ledger's own rows disagree", () => {
    expect(onlyOrder([outcome("created"), outcome("created", { amount_minor: "3300" })]).amountMinor).toBeNull();
  });

  it("still reads a row written before the rename to minor units", () => {
    const old = outcome("created", { amount_paise: "52000", currency: "USD" });
    delete old.payload["amount_minor"];
    expect(onlyOrder([old]).amountMinor).toBe(52000n);
  });

  it("refuses a malformed amount instead of guessing", () => {
    expect(() => viewTrace(rows(outcome("created", { amount_minor: "32.00" })))).toThrow(TypeError);
    expect(() => viewTrace(rows(outcome("created", { amount_minor: 3200 })))).toThrow(TypeError);
  });

  it("reads the standing refund: the newest attempt whose latest row isn't a failure", () => {
    const paid = [outcome("created"), outcome("captured")];
    expect(onlyOrder([...paid, refundRequested(), refundOutcome("refunded")]).refund).toEqual({ state: "refunded", refundId: REFUND, amountMinor: 3200n, currency: "USD" });
    expect(onlyOrder([...paid, refundRequested(), refundOutcome("pending")]).refund.state).toBe("pending");
    expect(onlyOrder([...paid, refundRequested(), refundOutcome("pending"), refundOutcome("refunded")]).refund.state).toBe("refunded");
    expect(onlyOrder([...paid, refundRequested(), refundOutcome("pending"), refundOutcome("failed")]).refund.state).toBe("none");
    expect(onlyOrder([...paid, refundRequested(), refundOutcome("failed"), refundRequested("rk2"), refundOutcome("refunded", { refund_key: "rk2" })]).refund.state).toBe("refunded");
    expect(onlyOrder([...paid, refundRequested()]).refund.state).toBe("requested");
    expect(onlyOrder([...paid, refundOutcome("mismatch", { failure_code: "RAIL_AMOUNT_MISMATCH" })]).refund.state).toBe("mismatch");
  });

  it("ignores a refund row about another order", () => {
    expect(onlyOrder([outcome("captured"), refundOutcome("refunded", { order_id: "ANOTHERORDER00001" })]).refund.state).toBe("none");
  });

  it("keeps two PayPal orders on one trace apart", () => {
    const trace = viewTrace(rows(outcome("captured"), outcome("created", { order_id: "ANOTHERORDER00001", amount_minor: "500" })));
    expect(trace.kind === "paypal" && trace.orders.map((o) => [o.orderId, o.status, o.amountMinor])).toEqual([
      [ORDER, "captured", 3200n],
      ["ANOTHERORDER00001", "created", 500n],
    ]);
  });

  it("says when there is nothing on the PayPal rail", () => {
    expect(viewTrace([])).toEqual({ kind: "empty" });
    expect(viewTrace(rows(intent, denied))).toEqual({ kind: "no_paypal_order", rails: [], ordersOnOtherRails: 0 });
    expect(viewTrace(rows(intent, outcome("created", { rail: "razorpay", order_id: "order_Qx1", currency: "INR" })))).toEqual({ kind: "no_paypal_order", rails: ["razorpay"], ordersOnOtherRails: 1 });
    expect(viewTrace(rows(outcome("captured", { rail: "simulated", order_id: "sim_1" })))).toEqual({ kind: "no_paypal_order", rails: ["simulated"], ordersOnOtherRails: 1 });
    // A create PayPal refused made no order: the row has no order id.
    expect(viewTrace(rows(outcome("failed", { order_id: "", failure_code: "CURRENCY_NOT_SUPPORTED" })))).toEqual({ kind: "no_paypal_order", rails: ["paypal"], ordersOnOtherRails: 0 });
    // A row from before rows named their rail is a Razorpay row.
    const old = outcome("created", { order_id: "order_old" });
    delete old.payload["rail"];
    expect(viewTrace(rows(old))).toEqual({ kind: "no_paypal_order", rails: [], ordersOnOtherRails: 1 });
  });
});
