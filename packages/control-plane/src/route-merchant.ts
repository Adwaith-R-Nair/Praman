import { loadMerchantConfig, type PrismaTx } from "@praman/db";
import type { Executor, ExecutorRouter } from "@praman/exec-core";
import type { Decision } from "@praman/policy";

export type RoutedMerchant =
  | { readonly ok: true; readonly executor: Executor }
  | { readonly ok: false; readonly detail: string };

/** The rail comes from server-side merchant configuration, and only from there. */
export async function routeMerchant(tx: PrismaTx, merchantId: string, route: ExecutorRouter): Promise<RoutedMerchant> {
  const config = await loadMerchantConfig(tx, merchantId);
  if (config === null) return { ok: false, detail: `merchant ${merchantId} has no configuration` };
  const executor = route(config.rail);
  if (executor === null) return { ok: false, detail: `merchant ${merchantId} is on rail ${config.rail}, which has no executor here` };
  return { ok: true, executor };
}

export type RailGate =
  | { readonly decision: Exclude<Decision, { kind: "DENY" }>; readonly executor: Executor }
  | { readonly decision: Extract<Decision, { kind: "DENY" }>; readonly executor: null };

/**
 * A purchase Praman has no way to carry out is denied, with nothing recorded as
 * attempted. Policy answers first, so its reason is never hidden by this one and
 * a merchant's rail is never revealed for a purchase policy refused. A STEP_UP is
 * denied too: a human should not approve what can't happen. Not a policy rule, so
 * it lives here, and it can only turn a yes into a no.
 */
export function gateOnRail(evaluated: Decision, routed: RoutedMerchant): RailGate {
  if (evaluated.kind === "DENY") return { decision: evaluated, executor: null };
  if (!routed.ok) return { decision: { kind: "DENY", reason_code: "MERCHANT_OUT_OF_SCOPE", detail: routed.detail }, executor: null };
  return { decision: evaluated, executor: routed.executor };
}
