import { describe, expect, it } from "vitest";
import { minor, type Rail } from "@praman/shared";
import { acceptOutcome, outcomeFields, routeAllTo, routeByRail, type ExecOutcome, type Executor } from "../src/index.js";
import { SimulatedExecutor } from "../src/simulated.js";

const OUTCOME: ExecOutcome = {
  rail: "simulated",
  order_id: "order_1",
  status: "created",
  amount_minor: minor(1250n),
  currency: "USD",
  payment_id: null,
  approve_url: "https://example.test/approve",
  failure_code: null,
};

function stubFor(rail: Rail): Executor {
  const inner = new SimulatedExecutor();
  return {
    rail,
    createOrder: (req) => inner.createOrder(req),
    findOrder: (lookup) => inner.findOrder(lookup),
    capture: (req) => inner.capture(req),
  };
}

describe("routeAllTo", () => {
  it("sends every rail to the one executor", () => {
    const executor = new SimulatedExecutor();
    const route = routeAllTo(executor);
    expect(route("razorpay")).toBe(executor);
    expect(route("paypal")).toBe(executor);
    expect(route("simulated")).toBe(executor);
  });
});

describe("routeByRail", () => {
  it("returns the executor for that rail and null for any other", () => {
    const razorpay = stubFor("razorpay");
    const paypal = stubFor("paypal");
    const route = routeByRail([razorpay, paypal]);
    expect(route("razorpay")).toBe(razorpay);
    expect(route("paypal")).toBe(paypal);
    expect(route("simulated")).toBeNull();
  });
});

describe("acceptOutcome", () => {
  const ASKED_USD = { amount_minor: minor(1250n), currency: "USD" } as const;
  const ASKED_INR = { amount_minor: minor(1250n), currency: "INR" } as const;

  it("returns an outcome matching the request untouched", () => {
    expect(acceptOutcome(OUTCOME, ASKED_USD)).toBe(OUTCOME);
  });

  it("marks an order in another currency as a mismatch, at the authorised money, keeping what the rail said", () => {
    expect(acceptOutcome(OUTCOME, ASKED_INR)).toEqual({
      ...OUTCOME,
      status: "mismatch",
      currency: "INR",
      approve_url: null,
      failure_code: "RAIL_CURRENCY_MISMATCH",
      rail_status: "created",
      rail_amount_minor: 1250n,
      rail_currency: "USD",
    });
  });

  it("keeps the fact that a mismatched order was captured", () => {
    const captured: ExecOutcome = { ...OUTCOME, status: "captured", payment_id: "pay_1" };
    expect(acceptOutcome(captured, ASKED_INR)).toMatchObject({ status: "mismatch", rail_status: "captured", payment_id: "pay_1" });
  });

  it.each([
    ["lower", 1n],
    ["higher", 9999n],
  ])("marks an order for a %s amount as a mismatch, at the authorised amount", (_name, reported) => {
    const outcome: ExecOutcome = { ...OUTCOME, amount_minor: minor(reported) };
    expect(acceptOutcome(outcome, ASKED_USD)).toEqual({
      ...OUTCOME,
      status: "mismatch",
      approve_url: null,
      failure_code: "RAIL_AMOUNT_MISMATCH",
      rail_status: "created",
      rail_amount_minor: reported,
      rail_currency: "USD",
    });
  });

  it("names the currency when both differ, since amounts in two currencies can't be compared", () => {
    const outcome: ExecOutcome = { ...OUTCOME, amount_minor: minor(1n) };
    expect(acceptOutcome(outcome, ASKED_INR)).toMatchObject({ failure_code: "RAIL_CURRENCY_MISMATCH", amount_minor: 1250n, currency: "INR", rail_amount_minor: 1n });
  });

  it("leaves a failure alone whatever amount it reports", () => {
    const failed: ExecOutcome = { ...OUTCOME, status: "failed", amount_minor: minor(1n), approve_url: null, failure_code: "BAD_REQUEST_ERROR" };
    expect(acceptOutcome(failed, ASKED_USD)).toBe(failed);
  });

  it("leaves a failure alone: no order exists, so there is nothing to mismatch, and the rail's code stands", () => {
    const failed: ExecOutcome = { ...OUTCOME, status: "failed", approve_url: null, failure_code: "CURRENCY_NOT_SUPPORTED" };
    expect(acceptOutcome(failed, ASKED_INR)).toBe(failed);
  });
});

describe("outcomeFields", () => {
  it("writes the outcome's fields with its amount as a string, and no rail_ fields when they agree", () => {
    expect(outcomeFields(OUTCOME)).toEqual({
      rail: "simulated",
      status: "created",
      order_id: "order_1",
      payment_id: null,
      failure_code: null,
      amount_minor: "1250",
      currency: "USD",
    });
  });

  it("adds what the rail said on a mismatch, next to the authorised money", () => {
    const fields = outcomeFields(acceptOutcome(OUTCOME, { amount_minor: minor(1250n), currency: "INR" }));
    expect(fields).toMatchObject({
      status: "mismatch",
      amount_minor: "1250",
      currency: "INR",
      failure_code: "RAIL_CURRENCY_MISMATCH",
      rail_status: "created",
      rail_amount_minor: "1250",
      rail_currency: "USD",
    });
  });
});
