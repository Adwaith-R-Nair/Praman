import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { mirrorPlan, railFor } from "../src/fixtures.js";
import { computeMetrics } from "../src/metrics.js";
import { generateReportMarkdown } from "../src/report.js";
import { prisma } from "../src/db.js";
import { runLayer1 } from "../src/runner.js";
import type { CaseResult, Layer1Case } from "../src/types.js";

const CORPUS = JSON.parse(
  readFileSync(fileURLToPath(new URL("../corpus/layer1.json", import.meta.url)), "utf8"),
) as Layer1Case[];

function corpusCase(id: string): Layer1Case {
  const found = CORPUS.find((c) => c.case_id === id);
  if (found === undefined) throw new Error(`no corpus case ${id}`);
  return found;
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("which rail a merchant is on", () => {
  it("puts rupee merchants on Razorpay and dollar merchants on PayPal", () => {
    expect(railFor("INR")).toBe("razorpay");
    expect(railFor("USD")).toBe("paypal");
  });
});

describe("mirroring a case onto the other rail", () => {
  it("mirrors a rupee case into dollars", () => {
    expect(mirrorPlan(corpusCase("adv_scope_giftcard_as_food"))).toEqual({ kind: "mirror", currency: "USD" });
  });

  it("mirrors a dollar case into rupees", () => {
    expect(mirrorPlan(corpusCase("benign_usd_happy_001"))).toEqual({ kind: "mirror", currency: "INR" });
  });

  it("mirrors a capture case, whose order is in the mandate's currency", () => {
    expect(mirrorPlan(corpusCase("benign_hold_capture_live_order"))).toEqual({ kind: "mirror", currency: "USD" });
  });

  it("leaves a currency-mismatch case alone, because the mismatch is what it tests", () => {
    const plan = mirrorPlan(corpusCase("adv_numeric_currency_usd_mandate_inr_item"));
    expect(plan.kind).toBe("skip");
  });

  it("leaves a mandate in an unsupported currency alone", () => {
    expect(mirrorPlan(corpusCase("adv_numeric_unsupported_mandate_currency")).kind).toBe("skip");
  });

  it("leaves a v1 mandate alone, because v1 can only be in rupees", () => {
    const v1 = CORPUS.find((c) => c.mandate === "lunch_5000_high_stepup");
    expect(v1).toBeDefined();
    if (v1 !== undefined) expect(mirrorPlan(v1)).toEqual({ kind: "skip", why: "a v1 mandate can only be in INR" });
  });
});

describe("a mirrored run", () => {
  it("runs the same case at a PayPal merchant in dollars, and decides the same", async () => {
    const c = corpusCase("adv_scope_giftcard_as_food");
    const native = await runLayer1(c);
    const mirrored = await runLayer1(c, "USD");

    expect(native).toMatchObject({ rail: "razorpay", currency: "INR", mirrored: false, passed: true });
    expect(mirrored).toMatchObject({ rail: "paypal", currency: "USD", mirrored: true, passed: true });
    expect(mirrored.reason_code).toBe(native.reason_code);
    expect(mirrored.money_moved).toBe(native.money_moved);

    // The seeded merchant really is a PayPal merchant in dollars.
    const merchant = await prisma.merchant.findUnique({ where: { merchantId: c.intent.merchant_id } });
    expect(merchant).toMatchObject({ rail: "paypal", currency: "USD" });
  });

  it("lets a benign purchase through on both rails", async () => {
    const c = corpusCase("benign_usd_happy_001");
    const native = await runLayer1(c);
    const mirrored = await runLayer1(c, "INR");
    expect(native).toMatchObject({ rail: "paypal", money_moved: true, passed: true, mirrored: false });
    expect(mirrored).toMatchObject({ rail: "razorpay", currency: "INR", money_moved: true, passed: true, mirrored: true });
  });
});

function run(case_id: string, rail: "razorpay" | "paypal", mirrored: boolean, money_moved: boolean, reason_code: string): CaseResult {
  return {
    case_id,
    family: "scope_drift",
    layer: 1,
    rail,
    mirrored,
    money_moved,
    expected_money_moves: false,
    amount_moved_minor: 0n,
    reason_code,
    decision_kind: money_moved ? "ALLOW" : "DENY",
    passed: !money_moved,
    incidental: false,
    money_at_risk_minor: 5000n,
    currency: rail === "razorpay" ? "INR" : "USD",
    latency_ms: 1,
    detail: "",
  };
}

describe("metrics with mirrored runs", () => {
  const results = [
    run("adv_a", "razorpay", false, false, "SKU_UNKNOWN"),
    run("adv_a", "paypal", true, false, "SKU_UNKNOWN"),
    run("adv_b", "razorpay", false, false, "CATEGORY_OUT_OF_SCOPE"),
    run("adv_b", "paypal", true, false, "MERCHANT_OUT_OF_SCOPE"),
  ];

  it("counts each corpus case once in the headline rates and money at risk", () => {
    const metrics = computeMetrics(results);
    const n = metrics.counts.containment_rate_dev.n + metrics.counts.containment_rate_heldout.n;
    expect(n).toBe(2);
    // A mirrored run's amount is the same integer relabelled, not dollars anyone risked.
    expect(metrics.money_at_risk_prevented_minor).toEqual({ INR: "10000", USD: "0" });
  });

  it("reports how many mirrored runs matched the native run", () => {
    const metrics = computeMetrics(results);
    expect(metrics.rail_parity).toEqual({ mirrored_runs: 2, same_outcome_and_reason: 1, passed: 2 });
  });

  it("prints a row per rail and names the cases that ran on one rail only", () => {
    const metrics = computeMetrics(results);
    const report = generateReportMarkdown({
      results,
      metrics,
      generated_at: "2026-11-08T00:00:00.000Z",
      not_mirrored: [{ case_id: "adv_c", why: "a v1 mandate can only be in INR" }],
    });
    expect(report).toContain("## Both rails");
    expect(report).toMatch(/\| razorpay \| INR \| 2 \| 2 \|/);
    expect(report).toMatch(/\| paypal \| USD \| 2 \| 2 \|/);
    expect(report).toContain("1 of 2 mirrored runs");
    expect(report).toContain("| adv_c | a v1 mandate can only be in INR |");
  });
});
