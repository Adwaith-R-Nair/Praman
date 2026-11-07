import { randomBytes } from "node:crypto";
import type { MandateDocumentV2 } from "@praman/mandate";
import { DEMO_SHOP } from "./env.js";

/**
 * What the person lets an MCP agent spend at DEMO_SHOP, in US cents. Set by the
 * person who runs pnpm mcp:mandate, and signed. The agent never sees these numbers
 * (D-08), only what they lead to.
 *
 * With the Channel3 snapshot this gives the gateway's story: kitchen and office
 * things under $30 go through once DEMO_SHOP is trusted, $30 and up needs a
 * person, over $60 is refused, and headphones or lamps are outside the mandate.
 */
export const GATEWAY_TERMS = {
  merchant_ids: [DEMO_SHOP],
  categories: ["kitchen-dining", "general-office-supplies"],
  max_per_txn_minor: "6000",
  max_total_minor: "15000",
  threshold_minor: "3000",
  max_txns_per_window: 6,
  window_seconds: 3600,
  max_denials_per_window: 5,
} as const;

export function gatewayMandate(now: Date, hours: number): MandateDocumentV2 {
  return {
    mandate_id: `mnd_mcp_${randomBytes(6).toString("hex")}`,
    version: 2,
    issuer_id: "usr_adwaith",
    subject_id: "agt_mcp_client",
    scope: { merchant_ids: [...GATEWAY_TERMS.merchant_ids], categories: [...GATEWAY_TERMS.categories], currency: "USD" },
    limits: {
      max_per_txn_minor: GATEWAY_TERMS.max_per_txn_minor,
      max_total_minor: GATEWAY_TERMS.max_total_minor,
      max_txns_per_window: GATEWAY_TERMS.max_txns_per_window,
      window_seconds: GATEWAY_TERMS.window_seconds,
      max_denials_per_window: GATEWAY_TERMS.max_denials_per_window,
    },
    step_up: { threshold_minor: GATEWAY_TERMS.threshold_minor },
    validity: { not_before: now.toISOString(), not_after: new Date(now.getTime() + hours * 3600_000).toISOString() },
    nonce: randomBytes(8).toString("hex"),
  };
}
