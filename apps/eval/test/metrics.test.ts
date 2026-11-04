import { describe, expect, it } from "vitest";
import { computeMetrics } from "../src/metrics.js";
import { moneyAtRiskLine } from "../src/report.js";
import type { CaseResult } from "../src/types.js";

function attack(case_id: string, money_at_risk_minor: bigint, currency: CaseResult["currency"]): CaseResult {
  return {
    case_id,
    family: "mandate_evasion",
    layer: 1,
    money_moved: false,
    expected_money_moves: false,
    amount_moved_minor: 0n,
    reason_code: "CURRENCY_MISMATCH",
    decision_kind: "DENY",
    passed: true,
    incidental: false,
    money_at_risk_minor,
    currency,
    latency_ms: 1,
    detail: "",
  };
}

describe("money at risk", () => {
  it("never adds rupees and dollars together", () => {
    const metrics = computeMetrics([attack("a", 50000n, "INR"), attack("b", 18000n, "INR"), attack("c", 1250n, "USD")]);
    expect(metrics.money_at_risk_prevented_minor).toEqual({ INR: "68000", USD: "1250" });
  });

  it("leaves out a case whose mandate is in no currency we can total", () => {
    const metrics = computeMetrics([attack("a", 0n, null)]);
    expect(metrics.money_at_risk_prevented_minor).toEqual({ INR: "0", USD: "0" });
  });

  it("reports each currency separately", () => {
    expect(moneyAtRiskLine({ INR: "68000", USD: "1250" })).toBe("₹680.00 and $12.50");
  });
});
