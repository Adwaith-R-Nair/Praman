import { describe, expect, it } from "vitest";
import { computeMetrics } from "../src/metrics.js";
import { generateReportMarkdown, type AblationSummary } from "../src/report.js";
import { splitAssignment } from "../src/split.js";
import type { CaseResult } from "../src/types.js";

// The report's prose has to stay true as the corpus and the code change.
// These pin the sentences that used to be typed by hand and went stale.

function l1(case_id: string): CaseResult {
  return {
    case_id,
    family: "scope_drift",
    layer: 1,
    money_moved: false,
    expected_money_moves: false,
    amount_moved_minor: 0n,
    reason_code: "SKU_UNKNOWN",
    decision_kind: "DENY",
    passed: true,
    incidental: false,
    money_at_risk_minor: 100n,
    currency: "INR",
    latency_ms: 1,
    detail: "",
  };
}

function l2(case_id: string, influenced: boolean): CaseResult {
  return {
    ...l1(case_id),
    family: "prompt_injection",
    layer: 2,
    reason_code: influenced ? "CATEGORY_OUT_OF_SCOPE" : "OK",
    decision_kind: influenced ? "DENY" : "ALLOW",
    influenced,
    detail: influenced ? "injected sku(s) reached the proposal: SKU_X" : "",
  };
}

function ablation(measured_on: string | null): AblationSummary {
  return {
    model_id: "google/gemini-3.1-flash-lite",
    measured_on,
    defended: { runs: 21, influenced: 0, moneyMoved: 0, influencedAndMoneyMoved: 0 },
    undefended: { runs: 21, influenced: 2, moneyMoved: 0, influencedAndMoneyMoved: 0 },
  };
}

function report(results: readonly CaseResult[], a?: AblationSummary): string {
  return generateReportMarkdown({
    results,
    metrics: computeMetrics(results),
    generated_at: "2026-11-08T00:00:00.000Z",
    ...(a !== undefined ? { ablation: a } : {}),
  });
}

describe("the report's wording", () => {
  it("states the held-out split of the cases that actually ran", () => {
    const results = Array.from({ length: 20 }, (_, i) => l1(`case_${i.toString()}`));
    const heldout = results.filter((r) => splitAssignment(r.case_id) === "heldout").length;
    expect(report(results)).toContain(`${heldout.toString()} of the 20 Layer 1 cases are in the held-out split`);
  });

  it("says Layer 2 figures predate the catalog line change when they do", () => {
    const text = report([l1("a")], ablation("2026-09-05"));
    expect(text).toContain("recorded 2026-09-05");
    expect(text).toContain("before 2026-11-05");
  });

  it("drops that warning for an ablation recorded after the change", () => {
    expect(report([l1("a")], ablation("2026-11-10"))).not.toContain("before 2026-11-05");
  });

  it("says the date is unknown rather than leaving the warning out", () => {
    expect(report([l1("a")], ablation(null))).toContain("before 2026-11-05");
  });

  it("says when no Layer 2 case ran", () => {
    expect(report([l1("a")])).toContain("No Layer 2 case ran for this report.");
  });

  it("doesn't say Layer 2 hasn't been rerun when this report ran it", () => {
    const text = report([l1("a"), l2("inj_a", false)], ablation("2026-09-05"));
    expect(text).not.toContain("Layer 2 has not been rerun since");
    expect(text).toContain("before 2026-11-05");
    expect(text).toContain("The Layer 2 cases above ran on the current catalog line");
  });

  it("lists each Layer 2 case with what the model did and what the policy decided", () => {
    const text = report([l1("a"), l2("inj_a", true), l2("inj_b", false)]);
    expect(text).toContain("| case_id | influenced | decision | reason code | money moved |");
    expect(text).toContain("| inj_a | yes | DENY | CATEGORY_OUT_OF_SCOPE | no |");
    expect(text).toContain("| inj_b | no | ALLOW | OK | no |");
  });

  it("names the catalog line the Layer 2 cases ran against", () => {
    expect(report([l2("inj_a", false)])).toContain("`price_minor=48000 currency=INR`");
  });

  it("defines money_moved for capture cases", () => {
    expect(report([l1("a")])).toContain("For a capture case, `money_moved` means `evaluateCapture` allowed the capture");
  });

  it("doesn't call an ablation gap measured when the Fisher test can't tell it from chance", () => {
    const text = report([l1("a")], ablation("2026-09-05"));
    expect(text).not.toContain("a measured difference, not an assumed one");
    expect(text).toContain("p = 0.49");
  });

  it("doesn't claim no corpus case has ever failed, since deliberate faults made some fail", () => {
    const text = report([l1("a")]);
    expect(text).not.toContain("no case has yet been observed to fail");
    expect(text).toContain("currency check removed, the 2 mismatch cases failed");
  });

  it("doesn't claim only planted faults have failed cases, since the corpus found a real crash", () => {
    const text = report([l1("a")]);
    expect(text).not.toContain("only when a fault was put in on purpose");
    expect(text).toContain("`c971f34`");
    expect(text).toContain("`c8fbc86` broke 3 cases by accident");
  });

  it("has no em dash in the prose it generates", () => {
    expect(report([l1("a")], ablation("2026-09-05"))).not.toContain("—");
  });
});
