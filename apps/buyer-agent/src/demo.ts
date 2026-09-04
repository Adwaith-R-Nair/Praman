import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { env } from "node:process";
import { fileURLToPath } from "node:url";
import { runIntent } from "@praman/control-plane";
import { LiveExecutor, SimulatedExecutor } from "@praman/razorpay-exec";
import type { SignedMandate } from "@praman/mandate";
import type { PurchaseIntent } from "@praman/policy";
import { formatINR } from "@praman/shared";
import { GeminiProvider } from "@praman/agent-core";
import { runAgent } from "./agent.js";

const goal = process.argv[2] ?? "order lunch for two under ₹700";
const merchantId = env["DEMO_MERCHANT_ID"] ?? "MERCH_001";
const live = env["PRAMAN_LIVE"] === "1";

const geminiKey = env["GEMINI_API_KEY"];
if (!geminiKey) throw new Error("GEMINI_API_KEY is not set");
const publicKeyB64 = env["MANDATE_PUBLIC_KEY"];
if (!publicKeyB64) throw new Error("MANDATE_PUBLIC_KEY is not set");
const publicKeyPem = Buffer.from(publicKeyB64, "base64").toString("utf8");

const mandatePath = fileURLToPath(new URL("../../../mandate.json", import.meta.url));
const signed = JSON.parse(readFileSync(mandatePath, "utf8")) as SignedMandate;

console.log(`\n▸ goal: ${goal}`);
console.log(`▸ merchant: ${merchantId}`);
console.log(`▸ executor: ${live ? "LIVE (real Razorpay test-mode order)" : "simulated"}\n`);

const provider = new GeminiProvider(geminiKey, "gemini-3.1-flash-lite");
const agent = await runAgent(provider, goal, merchantId);

if (agent.kind !== "PROPOSED") {
  console.log(`▸ agent made no proposal (${agent.kind})`);
  if (agent.kind === "NO_PROPOSAL") console.log(`  reason: ${agent.reason}`);
  process.exit(0);
}

console.log(`▸ agent proposes: ${agent.cart.line_items.map((i) => `${i.qty}× ${i.sku}`).join(", ")}`);
console.log(`  rationale: ${agent.cart.rationale}`);
console.log(`  model: ${agent.modelId}\n`);

const intent: PurchaseIntent = {
  intent_id: `int_${randomUUID()}`,
  mandate_id: signed.document.mandate_id,
  merchant_id: agent.cart.merchant_id,
  line_items: agent.cart.line_items,
  requested_at: new Date().toISOString(),
  agent_rationale: agent.cart.rationale,
};

const executor = live
  ? new LiveExecutor(env["RAZORPAY_KEY_ID"] ?? "", env["RAZORPAY_KEY_SECRET"] ?? "")
  : new SimulatedExecutor();

const result = await runIntent(intent, signed, publicKeyPem, executor, new Date(), agent.modelId);

if (result.kind === "IN_FLIGHT") {
  console.log(`▸ IN FLIGHT — ${result.detail}`);
  process.exit(0);
}

const v = result.agent_visible;
console.log(`▸ decision: ${v.kind}`);
if (v.kind !== "DENY") console.log(`  amount: ${formatINR(v.amount_paise)}`);
else console.log(`  reason: ${v.reason_code}`);
console.log(`  trace:  ${result.trace_id}`);
if (result.order_id) console.log(`  order:  ${result.order_id}`);
console.log(`\n  (agent sees only the above — mandate limits are redacted, D-08)`);
console.log(`  internal reason code: ${result.internal_reason_code}\n`);
