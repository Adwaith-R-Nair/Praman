import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { env } from "node:process";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import type { SignedMandate } from "@praman/mandate";
import type { PurchaseIntent } from "@praman/policy";

// Same reason as approve.ts/verify-ledger.ts — dotenv must load before any
// dynamic import reaches @praman/db (via @praman/control-plane here). Type-only
// imports above are erased at compile time and never actually execute, so
// they're safe to keep static.
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const { runIntent } = await import("@praman/control-plane");
const { LiveExecutor, SimulatedExecutor } = await import("@praman/razorpay-exec");
const { formatINR } = await import("@praman/shared");
const { GeminiProvider } = await import("@praman/agent-core");
const { runAgent } = await import("./agent.js");
const { recordAgentTranscript } = await import("./record-transcript.js");

const baseGoal = process.argv[2] ?? "order lunch for two under ₹700";
const merchantId = env["DEMO_MERCHANT_ID"] ?? "MERCH_001";
const live = env["PRAMAN_LIVE"] === "1";
const failWith = env["PRAMAN_FAIL"];
if (failWith !== undefined && failWith !== "declined" && failWith !== "timeout") {
  throw new Error(`PRAMAN_FAIL must be "declined" or "timeout", got: ${failWith}`);
}

const geminiKey = env["GEMINI_API_KEY"];
if (!geminiKey) throw new Error("GEMINI_API_KEY is not set");
const publicKeyB64 = env["MANDATE_PUBLIC_KEY"];
if (!publicKeyB64) throw new Error("MANDATE_PUBLIC_KEY is not set");
const publicKeyPem = Buffer.from(publicKeyB64, "base64").toString("utf8");

const mandatePath = fileURLToPath(new URL("../../../mandate.json", import.meta.url));
const signed = JSON.parse(readFileSync(mandatePath, "utf8")) as SignedMandate;

console.log(`\n▸ goal: ${baseGoal}`);
console.log(`▸ merchant: ${merchantId}`);
console.log(
  `▸ executor: ${live ? "LIVE (real Razorpay test-mode order)" : `simulated${failWith ? ` (forced: ${failWith})` : ""}`}\n`,
);

const provider = new GeminiProvider(geminiKey, "gemini-3.1-flash-lite");

// Declined → the agent may re-plan once with a genuinely different cart (new
// intent, new idempotency key). Timeout → runIntent returns IN_FLIGHT and we
// stop; the system declining to act because it doesn't know what happened is
// the actual demo beat, not a successful retry. The retry cap lives here, in
// the demo loop, not inside the agent.
const MAX_ATTEMPTS = 2;

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  const goal =
    attempt === 1
      ? baseGoal
      : `${baseGoal}\n\nNote: your previous proposal was declined by the payment provider. ` +
        `You may retry with the same cart, or choose differently if that better serves the goal — ` +
        `your judgement. This is your last attempt.`;

  if (attempt > 1) console.log(`▸ retry ${(attempt - 1).toString()}/${(MAX_ATTEMPTS - 1).toString()} — declined, re-planning\n`);

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
    : new SimulatedExecutor(failWith);

  const result = await runIntent(intent, signed, publicKeyPem, executor, new Date(), agent.modelId);
  // For the receipt viewer: the merchant text the agent read and its
  // verbatim tool call, not just the final decided intent.
  await recordAgentTranscript(result.trace_id, agent.transcript);

  if (result.kind === "IN_FLIGHT") {
    console.log(`▸ IN FLIGHT — ${result.detail}`);
    console.log(`\n  The system does not know whether this order was created. It will not`);
    console.log(`  guess by retrying — that is how a double charge happens. A reconciler`);
    console.log(`  resolves this once Razorpay's own propagation lag has passed (D-22).\n`);
    process.exit(0);
  }

  const v = result.agent_visible;
  console.log(`▸ decision: ${v.kind}`);
  if (v.kind !== "DENY") console.log(`  amount: ${formatINR(v.amount_paise)}`);
  else console.log(`  reason: ${v.reason_code}`);
  console.log(`  trace:  ${result.trace_id}`);
  if (result.order_id) console.log(`  order:  ${result.order_id} (${result.order_status ?? "n/a"})`);
  console.log(`\n  (agent sees only the above — mandate limits are redacted, D-08)`);
  console.log(`  internal reason code: ${result.internal_reason_code}`);
  if (result.approval_id) {
    console.log(`\n  awaiting human approval — run one of:`);
    console.log(`    pnpm approve ${result.approval_id} approve`);
    console.log(`    pnpm approve ${result.approval_id} reject`);
  }
  console.log();

  if (result.order_status === "failed" && attempt < MAX_ATTEMPTS) {
    console.log(`▸ payment declined — one re-plan permitted\n`);
    continue;
  }
  if (result.order_status === "failed") {
    console.log(`▸ payment declined again on retry — stopping, not looping (velocity/retry caps are the backstop)\n`);
  }
  break;
}
