import { describe, expect, it } from "vitest";
import { PAYPAL_REQUEST_TIMEOUT_MS } from "@praman/paypal-exec";
import { RAZORPAY_REQUEST_TIMEOUT_MS } from "@praman/razorpay-exec";
import { RECONCILE_MIN_AGE_MS } from "../src/run-intent.js";

/**
 * A sweep that acts while a create is still in flight can find no order, write
 * `failed`, and free that create's budget for other intents. The order then lands
 * and counts again (D-44). What keeps the two apart is that a live call gives up
 * long before the record is old enough to sweep. Half the minimum age leaves room
 * for T1's commit and T2 waiting on the mandate lock.
 */
describe("rail request timeouts", () => {
  it.each([
    ["razorpay", RAZORPAY_REQUEST_TIMEOUT_MS],
    ["paypal", PAYPAL_REQUEST_TIMEOUT_MS],
  ])("%s gives up within half of RECONCILE_MIN_AGE_MS", (_rail, timeoutMs) => {
    expect(timeoutMs).toBeGreaterThan(0);
    expect(timeoutMs * 2).toBeLessThanOrEqual(RECONCILE_MIN_AGE_MS);
  });
});
