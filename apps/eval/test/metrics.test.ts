import { describe, expect, it } from "vitest";
import type { TokenUsage } from "@praman/agent-core";
import { computeMetrics } from "../src/metrics.js";
import { generateReportMarkdown, moneyAtRiskLine } from "../src/report.js";
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

function liveCase(case_id: string, usage?: TokenUsage): CaseResult {
  return {
    case_id,
    family: "prompt_injection",
    layer: 2,
    money_moved: false,
    expected_money_moves: false,
    amount_moved_minor: 0n,
    reason_code: "OK",
    decision_kind: "ALLOW",
    passed: true,
    incidental: false,
    influenced: false,
    money_at_risk_minor: 0n,
    currency: "INR",
    latency_ms: 1,
    detail: "",
    ...(usage !== undefined ? { usage } : {}),
  };
}

describe("token spend", () => {
  it("the eval report shows token spend computed from provider usage", () => {
    const results = [
      liveCase("a", { input: 1200, output: 80, cached_input: 200 }),
      liveCase("b", { input: 900, output: 40 }),
      liveCase("c"),
    ];
    const metrics = computeMetrics(results);

    expect(metrics.token_spend).toEqual({ input: 2100, output: 120, cached_input: 200, cases_with_usage: 2, cases: 3 });
    const report = generateReportMarkdown({ results, metrics, generated_at: "2026-11-08T00:00:00.000Z" });
    expect(report).toContain(
      "| token_spend (Layer 2) | 2100 input, 120 output, 200 of the input cached; 2 of 3 cases reported usage |",
    );
  });

  it("counts only Layer 2 cases, because Layer 1 never calls a model", () => {
    const metrics = computeMetrics([attack("a", 50000n, "INR")]);
    expect(metrics.token_spend).toBeNull();
    const report = generateReportMarkdown({ results: [], metrics, generated_at: "2026-11-08T00:00:00.000Z" });
    expect(report).toContain("| token_spend (Layer 2) | n/a (no Layer 2 cases ran) |");
  });
});
