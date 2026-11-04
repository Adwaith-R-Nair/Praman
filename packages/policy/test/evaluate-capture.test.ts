import { describe, expect, it } from "vitest";
import { minor } from "@praman/shared";
import { evaluateCapture, type CaptureInput } from "../src/evaluate-capture.js";
import type { LedgerDerivedState, VerifiedMandate } from "../src/types.js";

const KEY = "idem_order_1";
const NOW = new Date("2026-08-28T12:00:00Z");
const NOT_BEFORE = new Date("2026-08-28T00:00:00Z");
const NOT_AFTER = new Date("2026-08-29T00:00:00Z");

const MANDATE: VerifiedMandate = {
  mandate_id: "mnd_01",
  scope: { merchant_ids: ["MERCH_US_001"], categories: ["food"], currency: "USD" },
  limits: {
    max_per_txn_minor: minor(5000n),
    max_total_minor: minor(30000n),
    max_txns_per_window: 5,
    window_seconds: 3600,
    max_denials_per_window: 5,
  },
  step_up: { threshold_minor: minor(2500n) },
  validity: { not_before: NOT_BEFORE, not_after: NOT_AFTER },
};

const STATE: LedgerDerivedState = {
  spent_minor: minor(1250n),
  txn_timestamps: [new Date("2026-08-28T11:59:00Z")],
  revoked: false,
  merchants_transacted: new Set(["MERCH_US_001"]),
  seen_idempotency_keys: new Set([KEY]),
  released_keys: new Set(),
  denied_attempts: [],
};

const INPUT: CaptureInput = {
  mandate: MANDATE,
  state: STATE,
  now: NOW,
  order: {
    idempotency_key: KEY,
    held_amount_minor: minor(1250n),
    quoted_amount_minor: minor(1250n),
    currency: "USD",
  },
};

function withState(overrides: Partial<LedgerDerivedState>): CaptureInput {
  return { ...INPUT, state: { ...STATE, ...overrides } };
}

function withOrder(overrides: Partial<CaptureInput["order"]>): CaptureInput {
  return { ...INPUT, order: { ...INPUT.order, ...overrides } };
}

describe("evaluateCapture", () => {
  it("allows capture on a live mandate with matching amounts", () => {
    expect(evaluateCapture(INPUT)).toEqual({ kind: "ALLOW_CAPTURE", amount_minor: 1250n, reason_code: "OK" });
  });

  it("denies MANDATE_REVOKED when revoked during checkout", () => {
    expect(evaluateCapture(withState({ revoked: true }))).toMatchObject({ kind: "DENY", reason_code: "MANDATE_REVOKED" });
  });

  it("denies MANDATE_EXPIRED when expired during checkout", () => {
    const result = evaluateCapture({ ...INPUT, now: new Date(NOT_AFTER.getTime() + 1) });
    expect(result).toMatchObject({ kind: "DENY", reason_code: "MANDATE_EXPIRED" });
  });

  it("allows capture at the exact expiry instant, the same boundary as evaluate()", () => {
    expect(evaluateCapture({ ...INPUT, now: NOT_AFTER }).kind).toBe("ALLOW_CAPTURE");
  });

  it("denies MANDATE_NOT_YET_VALID before the window opens", () => {
    const result = evaluateCapture({ ...INPUT, now: new Date(NOT_BEFORE.getTime() - 1) });
    expect(result).toMatchObject({ kind: "DENY", reason_code: "MANDATE_NOT_YET_VALID" });
  });

  it("denies ORDER_RELEASED when the key was released", () => {
    expect(evaluateCapture(withState({ released_keys: new Set([KEY]) }))).toMatchObject({
      kind: "DENY",
      reason_code: "ORDER_RELEASED",
    });
  });

  it("is not affected by another order's release", () => {
    expect(evaluateCapture(withState({ released_keys: new Set(["idem_other"]) })).kind).toBe("ALLOW_CAPTURE");
  });

  it("reports the release first, because it is the reason this order can never be captured", () => {
    const result = evaluateCapture({
      ...withState({ released_keys: new Set([KEY]), revoked: true }),
      now: new Date(NOT_AFTER.getTime() + 1),
    });
    expect(result).toMatchObject({ kind: "DENY", reason_code: "ORDER_RELEASED" });
  });

  it.each([
    ["higher", 1251n],
    ["lower", 1249n],
  ])("denies AMOUNT_CHANGED_SINCE_APPROVAL when the rail amount is %s than the hold", (_name, quoted) => {
    expect(evaluateCapture(withOrder({ quoted_amount_minor: minor(quoted) }))).toMatchObject({
      kind: "DENY",
      reason_code: "AMOUNT_CHANGED_SINCE_APPROVAL",
    });
  });

  it("denies CURRENCY_MISMATCH when the order currency differs from the mandate", () => {
    expect(evaluateCapture(withOrder({ currency: "INR" }))).toMatchObject({
      kind: "DENY",
      reason_code: "CURRENCY_MISMATCH",
    });
  });

  it("checks currency before amount, because 1250 in another currency is not the same amount", () => {
    expect(evaluateCapture(withOrder({ currency: "INR", quoted_amount_minor: minor(9n) }))).toMatchObject({
      reason_code: "CURRENCY_MISMATCH",
    });
  });

  it("captures the held amount, never a figure the rail chose", () => {
    const decision = evaluateCapture(INPUT);
    expect(decision.kind === "ALLOW_CAPTURE" && decision.amount_minor).toBe(INPUT.order.held_amount_minor);
  });

  it("does not re-run the budget or velocity checks, because the hold already counted", () => {
    const result = evaluateCapture(
      withState({ spent_minor: MANDATE.limits.max_total_minor, txn_timestamps: Array.from({ length: 9 }, () => NOW) }),
    );
    expect(result.kind).toBe("ALLOW_CAPTURE");
  });

  it("is pure: same input deep-equals same output", () => {
    const allowed = Object.freeze({ ...INPUT });
    const denied = Object.freeze(withState({ revoked: true }));
    expect(evaluateCapture(allowed)).toEqual(evaluateCapture(allowed));
    expect(evaluateCapture(denied)).toEqual(evaluateCapture(denied));
  });
});
