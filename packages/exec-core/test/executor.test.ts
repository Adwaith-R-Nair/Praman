import { describe, expect, it } from "vitest";
import { minor, type Rail } from "@praman/shared";
import { acceptOutcome, routeAllTo, routeByRail, type ExecOutcome, type Executor } from "../src/index.js";
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
  it("returns an outcome in the requested currency untouched", () => {
    expect(acceptOutcome(OUTCOME, "USD")).toBe(OUTCOME);
  });

  it("turns an outcome in another currency into a typed failure, keeping what the rail said", () => {
    expect(acceptOutcome(OUTCOME, "INR")).toEqual({
      ...OUTCOME,
      status: "failed",
      approve_url: null,
      failure_code: "RAIL_CURRENCY_MISMATCH",
    });
  });
});
