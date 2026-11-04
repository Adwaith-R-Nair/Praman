import { loadMerchantConfig, type PrismaTx } from "@praman/db";
import type { Executor, ExecutorRouter } from "@praman/exec-core";
import type { Decision } from "@praman/policy";
import type { Currency } from "@praman/shared";

export type RoutedMerchant =
  | { readonly ok: true; readonly executor: Executor }
  | { readonly ok: false; readonly reason_code: "MERCHANT_OUT_OF_SCOPE" | "CURRENCY_MISMATCH"; readonly detail: string };

/**
 * The rail comes from server-side merchant configuration, and only from there. The
 * currency never does: the signed mandate names it, and a merchant in another one
 * is refused even if its catalog happens to agree with the mandate (D-35).
 */
export async function routeMerchant(tx: PrismaTx, merchantId: string, route: ExecutorRouter, mandateCurrency: Currency): Promise<RoutedMerchant> {
  const config = await loadMerchantConfig(tx, merchantId);
  if (config === null) return { ok: false, reason_code: "MERCHANT_OUT_OF_SCOPE", detail: `merchant ${merchantId} has no configuration` };
  if (config.currency !== mandateCurrency) {
    return { ok: false, reason_code: "CURRENCY_MISMATCH", detail: `merchant ${merchantId} is in ${config.currency}, the mandate is in ${mandateCurrency}` };
  }
  const executor = route(config.rail);
  if (executor === null) return { ok: false, reason_code: "MERCHANT_OUT_OF_SCOPE", detail: `merchant ${merchantId} is on rail ${config.rail}, which has no executor here` };
  return { ok: true, executor };
}

export type RailGate =
  | { readonly decision: Exclude<Decision, { kind: "DENY" }>; readonly executor: Executor }
  | { readonly decision: Extract<Decision, { kind: "DENY" }>; readonly executor: null };

/**
 * A purchase Praman has no way to carry out, or in a currency its merchant isn't
 * in, is denied, with nothing recorded as attempted. Policy answers first, so its reason is never hidden by this one and
 * a merchant's rail is never revealed for a purchase policy refused. A STEP_UP is
 * denied too: a human should not approve what can't happen. Not a policy rule, so
 * it lives here, and it can only turn a yes into a no.
 */
export function gateOnRail(evaluated: Decision, routed: RoutedMerchant): RailGate {
  if (evaluated.kind === "DENY") return { decision: evaluated, executor: null };
  if (!routed.ok) return { decision: { kind: "DENY", reason_code: routed.reason_code, detail: routed.detail }, executor: null };
  return { decision: evaluated, executor: routed.executor };
}
