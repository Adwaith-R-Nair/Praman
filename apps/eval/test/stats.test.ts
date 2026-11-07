import { describe, expect, it } from "vitest";
import { computeMetrics } from "../src/metrics.js";
import { generateReportMarkdown } from "../src/report.js";
import { fisherExactTwoSided, wilson95 } from "../src/stats.js";
import type { CaseResult } from "../src/types.js";

describe("wilson95", () => {
  it("wilson95(0, 21).high is about 0.155", () => {
    const { low, high } = wilson95(0, 21);
    expect(low).toBe(0);
    expect(high).toBeCloseTo(0.155, 3);
  });

  it("is symmetric: 21 of 21 mirrors 0 of 21", () => {
    const none = wilson95(0, 21);
    const all = wilson95(21, 21);
    expect(all.high).toBe(1);
    expect(all.low).toBeCloseTo(1 - none.high, 12);
  });

  it("stays inside 0 to 1 and contains the observed rate", () => {
    const { low, high } = wilson95(2, 21);
    expect(low).toBeGreaterThan(0);
    expect(low).toBeLessThan(2 / 21);
    expect(high).toBeGreaterThan(2 / 21);
    expect(high).toBeLessThan(1);
  });

  it("refuses counts that can't be a proportion", () => {
    expect(() => wilson95(0, 0)).toThrow();
    expect(() => wilson95(3, 2)).toThrow();
    expect(() => wilson95(-1, 2)).toThrow();
    expect(() => wilson95(1.5, 2)).toThrow();
  });
});

describe("fisherExactTwoSided", () => {
  it("fisherExactTwoSided(2, 19, 0, 21) is about 0.49", () => {
    // 2 of 21 influenced against 0 of 21: P = (210 + 210) / 861 = 0.4878.
    expect(fisherExactTwoSided(2, 19, 0, 21)).toBeCloseTo(0.4878, 4);
  });

  it("is 1 when the two arms are identical", () => {
    expect(fisherExactTwoSided(0, 21, 0, 21)).toBe(1);
    expect(fisherExactTwoSided(3, 18, 3, 18)).toBeCloseTo(1, 12);
  });

  it("gives the textbook value for a lopsided table", () => {
    // Fisher's tea tasting: 3 1 / 1 3, two-sided p = 34/70 = 0.4857.
    expect(fisherExactTwoSided(3, 1, 1, 3)).toBeCloseTo(34 / 70, 10);
    // 10 of 10 against 0 of 10: only the observed table and its mirror count.
    expect(fisherExactTwoSided(10, 0, 0, 10)).toBeCloseTo(2 / 184756, 12);
  });

  it("refuses counts that aren't whole and non-negative", () => {
    expect(() => fisherExactTwoSided(-1, 2, 3, 4)).toThrow();
    expect(() => fisherExactTwoSided(0.5, 2, 3, 4)).toThrow();
  });
});

function l1(case_id: string, family: string, money_moved: boolean, expected_money_moves: boolean): CaseResult {
  return {
    case_id,
    family,
    layer: 1,
    money_moved,
    expected_money_moves,
    amount_moved_minor: 0n,
    reason_code: money_moved ? "OK" : "SKU_UNKNOWN",
    decision_kind: money_moved ? "ALLOW" : "DENY",
    passed: money_moved === expected_money_moves,
    incidental: false,
    money_at_risk_minor: 1000n,
    currency: "INR",
    latency_ms: 1,
    detail: "",
  };
}

function l2(case_id: string, influenced: boolean): CaseResult {
  return { ...l1(case_id, "prompt_injection", false, !influenced), layer: 2, influenced, passed: true };
}

describe("the report", () => {
  it("the report prints n and an interval beside every rate", () => {
    // Enough distinct ids that both splits get attacks, whatever the hash does.
    const attacks = Array.from({ length: 12 }, (_, i) => l1(`adv_${i.toString()}`, "scope_drift", false, false));
    const results = [
      ...attacks,
      l1("benign_a", "benign", true, true),
      l1("benign_b", "benign", true, true),
      l2("live_a", true),
      l2("live_b", false),
    ];
    const metrics = computeMetrics(results);
    const report = generateReportMarkdown({ results, metrics, generated_at: "2026-11-08T00:00:00.000Z" });

    const rateRows = report.split("\n").filter((line) => /^\| (containment_rate_dev|containment_rate_heldout|false_refusal_rate|influence_rate|contained_despite_influence) \|/.test(line));
    expect(rateRows).toHaveLength(5);
    for (const row of rateRows) {
      expect(row).toMatch(/\d+\/\d+/);
      expect(row).toMatch(/95% CI \d+\.\d% to \d+\.\d%/);
    }
    expect(report).toContain("| false_refusal_rate | 0.0% (0/2, 95% CI 0.0% to 65.8%) |");
    expect(report).toContain("| influence_rate | 50.0% (1/2, 95% CI 9.5% to 90.5%) |");
  });

  it("prints the Fisher test beside the ablation arms", () => {
    const metrics = computeMetrics([]);
    const report = generateReportMarkdown({
      results: [],
      metrics,
      generated_at: "2026-11-08T00:00:00.000Z",
      ablation: {
        model_id: "google/gemini-3.1-flash-lite",
        measured_on: "2026-09-05",
        defended: { runs: 21, influenced: 0, moneyMoved: 0, influencedAndMoneyMoved: 0 },
        undefended: { runs: 21, influenced: 2, moneyMoved: 0, influencedAndMoneyMoved: 0 },
      },
    });
    expect(report).toContain("| Defended | 21 | 0 (0/21, 95% CI 0.0% to 15.5%) | 0 |");
    expect(report).toContain("| Undefended | 21 | 2 (2/21, 95% CI 2.7% to 28.9%) | 0 |");
    expect(report).toContain("p = 0.49");
  });
});
