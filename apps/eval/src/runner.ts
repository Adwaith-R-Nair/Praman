import { performance } from "node:perf_hooks";
// Must be imported before any package that reaches @praman/db (control-plane
// included) — its side effect points DATABASE_URL at TEST_DATABASE_URL
// before that package's module body reads it.
import "./db.js";
import { runIntent } from "@praman/control-plane";
import { SimulatedExecutor } from "@praman/razorpay-exec";
import type { PurchaseIntent } from "@praman/policy";
import { seedCase } from "./seed.js";
import type { CaseResult, Layer1Case } from "./types.js";

export async function runLayer1(c: Layer1Case): Promise<CaseResult> {
  const { signed, publicKeyPem, now } = await seedCase(c);

  const intent: PurchaseIntent = {
    intent_id: `int_${c.case_id}`,
    mandate_id: signed.document.mandate_id,
    merchant_id: c.intent.merchant_id,
    line_items: c.intent.line_items,
    requested_at: now.toISOString(),
    agent_rationale: `eval:${c.case_id}`,
  };

  const t0 = performance.now();
  const result = await runIntent(intent, signed, publicKeyPem, new SimulatedExecutor(), now, "eval-layer1");
  const latency_ms = performance.now() - t0;

  const moneyMoved = result.kind === "DECIDED" && result.order_id !== null && result.order_status !== "failed";
  const reasonCode = result.kind === "DECIDED" ? result.internal_reason_code : "IN_FLIGHT";
  const decisionKind = result.kind === "DECIDED" ? result.agent_visible.kind : "IN_FLIGHT";

  const outcomeMatches = moneyMoved === c.expected.money_moves;
  const reasonExpected = c.expected.acceptable_reason_codes.includes(reasonCode);

  return {
    case_id: c.case_id,
    family: c.family,
    layer: 1,
    money_moved: moneyMoved,
    amount_moved_paise: moneyMoved ? BigInt(c.money_at_risk_paise) : 0n,
    reason_code: reasonCode,
    decision_kind: decisionKind,
    // Both the money-movement outcome AND the specific reason code must match
    // — a case that happens to contain money for the wrong reason isn't
    // actually passing, it's `incidental` (see below), which is reported
    // separately rather than silently counted as a real pass.
    passed: outcomeMatches && reasonExpected,
    incidental: outcomeMatches && !reasonExpected,
    money_at_risk_paise: BigInt(c.money_at_risk_paise),
    latency_ms,
    detail: reasonExpected ? "" : `unexpected reason ${reasonCode} (money_moved=${String(moneyMoved)})`,
  };
}

export async function runLayer1Corpus(cases: readonly Layer1Case[]): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  for (const c of cases) {
    results.push(await runLayer1(c));
  }
  return results;
}
