import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { routeAllTo, routeByRail, SimulatedExecutor, type ExecutorRouter } from "@praman/exec-core";
import { verifyMandate, type SignedMandate } from "@praman/mandate";
import { PAYPAL_SANDBOX_BASE_URL, PayPalExecutor } from "@praman/paypal-exec";
import { Err, Ok, type Result } from "@praman/shared";
import type { GatewayDeps } from "./gateway.js";

/** The USD demo merchant that pnpm catalog:channel3 fills with real products. */
export const DEMO_SHOP = "DEMO_SHOP";
export const DEFAULT_MANDATE_PATH = fileURLToPath(new URL("../../../mcp-mandate.json", import.meta.url));
export const DEFAULT_RECEIPT_BASE_URL = "http://localhost:4100";

export interface GatewayEnv {
  readonly deps: GatewayDeps;
  /** "paypal-sandbox" or "simulated", said once on stderr at start so nobody mistakes one for the other. */
  readonly mode: "paypal-sandbox" | "simulated";
}

/**
 * Everything the gateway decides with, from the operator's environment and files.
 * Nothing here can come from a tool call. Fails closed: no mandate file, a
 * mandate that doesn't verify, or no PayPal keys outside simulation stops the
 * server before it accepts a single call.
 */
export function gatewayFromEnv(env: NodeJS.ProcessEnv, now: () => Date = () => new Date()): Result<GatewayEnv, string> {
  const publicKeyB64 = env["MANDATE_PUBLIC_KEY"];
  if (!publicKeyB64) return Err("MANDATE_PUBLIC_KEY is not set in .env");
  const publicKeyPem = Buffer.from(publicKeyB64, "base64").toString("utf8");

  const mandatePath = env["PRAMAN_MCP_MANDATE"] || DEFAULT_MANDATE_PATH;
  let signed: SignedMandate;
  try {
    signed = JSON.parse(readFileSync(mandatePath, "utf8")) as SignedMandate;
  } catch {
    return Err(`no readable mandate at ${mandatePath}. Issue one with: pnpm mcp:mandate`);
  }
  const verified = verifyMandate(signed, publicKeyPem);
  if (!verified.ok) return Err(`the mandate at ${mandatePath} doesn't verify (${verified.reason}). Issue a new one with: pnpm mcp:mandate`);

  let route: ExecutorRouter;
  let mode: GatewayEnv["mode"];
  if (env["PRAMAN_MCP_SIMULATE"] === "1") {
    // Every merchant goes to the simulator, and the ledger says "simulated" (D-32).
    route = routeAllTo(new SimulatedExecutor());
    mode = "simulated";
  } else {
    const clientId = env["PAYPAL_CLIENT_ID"];
    const clientSecret = env["PAYPAL_CLIENT_SECRET"];
    if (!clientId || !clientSecret) return Err("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are not set. Set them, or run with PRAMAN_MCP_SIMULATE=1");
    route = routeByRail([new PayPalExecutor({ clientId, clientSecret, baseUrl: PAYPAL_SANDBOX_BASE_URL, fetch: globalThis.fetch })]);
    mode = "paypal-sandbox";
  }

  const merchants = (env["PRAMAN_MCP_MERCHANTS"] || DEMO_SHOP).split(",").map((m) => m.trim()).filter((m) => m !== "");
  return Ok({
    mode,
    deps: {
      signed,
      publicKeyPem,
      route,
      merchants,
      receiptBaseUrl: (env["PRAMAN_RECEIPT_URL"] || DEFAULT_RECEIPT_BASE_URL).replace(/\/+$/, ""),
      now,
      newIntentId: () => `mcp_${randomUUID()}`,
    },
  });
}
