import { describe, expect, it } from "vitest";
import { TRANSACTION_MAX_WAIT_MS, TRANSACTION_TIMEOUT_MS } from "@praman/db";
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

  // The room that half leaves is spent by T2: after the rail answers, T2 may wait to
  // start and then wait for the mandate lock. If those waits could add up to more than
  // the other half, a sweep could act on a record whose own T2 is still on its way
  // (D-44, D-91). So the three limits together must stay under the minimum age.
  it.each([
    ["razorpay", RAZORPAY_REQUEST_TIMEOUT_MS],
    ["paypal", PAYPAL_REQUEST_TIMEOUT_MS],
  ])("%s: a rail call and the T2 after it finish before the record can be swept", (_rail, timeoutMs) => {
    expect(timeoutMs + TRANSACTION_MAX_WAIT_MS + TRANSACTION_TIMEOUT_MS).toBeLessThan(RECONCILE_MIN_AGE_MS);
  });
});
