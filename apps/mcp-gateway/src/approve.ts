import { fileURLToPath } from "node:url";
import { config } from "dotenv";

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

const approvalId = process.argv[2];
const verdict = process.argv[3];
if (approvalId === undefined || (verdict !== "approve" && verdict !== "reject")) {
  console.error("usage: pnpm mcp:approve <approval_id> approve|reject");
  process.exit(1);
}

/**
 * The person's half of a step-up. It refuses to run without a terminal, which
 * stops an agent that runs shell commands through a tool (as Claude Code's Bash
 * does, with no TTY) from approving its own purchase. An agent that can fake a
 * terminal can get past this; the decision record says what holds then.
 */
if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
  console.error("✗ pnpm mcp:approve must be run by a person in a terminal, not by a tool or a pipe.");
  process.exit(1);
}

const { gatewayFromEnv } = await import("./env.js");
const { resolveApproval } = await import("@praman/control-plane");
const { prisma } = await import("@praman/db");
const { formatMoney, isCurrency, minorFromDb } = await import("@praman/shared");
const { createInterface } = await import("node:readline/promises");

const loaded = gatewayFromEnv(process.env);
if (!loaded.ok) {
  console.error(`✗ ${loaded.error}`);
  process.exit(1);
}
const { deps, mode } = loaded.value;
const mandateId = deps.signed.document.mandate_id;

const approval = await prisma.approval.findFirst({ where: { approvalId, mandateId } });
if (approval === null) {
  console.error(`✗ no approval ${approvalId} under the gateway's mandate ${mandateId}`);
  await prisma.$disconnect();
  process.exit(1);
}
const intent: unknown = approval.intent;
const lines =
  typeof intent === "object" && intent !== null && "line_items" in intent && Array.isArray(intent.line_items) ? JSON.stringify(intent.line_items) : "?";
const merchant = typeof intent === "object" && intent !== null && "merchant_id" in intent ? String(intent.merchant_id) : "?";
const amount = isCurrency(approval.currency) ? formatMoney(minorFromDb(approval.amountMinor), approval.currency) : "?";

console.log(`\n  ${verdict === "approve" ? "Approve" : "Reject"} this purchase? (${mode})`);
console.log(`  merchant ${merchant}, items ${lines}, total ${amount}`);
console.log(`  approval ${approvalId}, trace ${approval.traceId}\n`);
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question(`  Type "${verdict}" to confirm: `)).trim();
rl.close();
if (answer !== verdict) {
  console.log("✗ not confirmed. Nothing changed.");
  await prisma.$disconnect();
  process.exit(1);
}

const result = await resolveApproval(approvalId, verdict, deps.signed, deps.publicKeyPem, deps.route, new Date());
switch (result.kind) {
  case "EXECUTED":
    if (result.order_status === "mismatch") console.log(`✗ the rail answered about something other than what was asked: order ${result.order_id ?? "?"}. Held until a person checks the trace.`);
    else if (result.order_status === "failed") console.log(`✗ the rail did not take this order. No money moved.`);
    else if (result.approve_url !== null) console.log(`✓ order ${result.order_id ?? "?"} created at PayPal. The buyer pays here:\n  ${result.approve_url}\n  then the agent calls complete_checkout.`);
    else console.log(`✓ executed: order ${result.order_id ?? "?"} (${result.order_status})`);
    break;
  case "REFUSED":
    console.log(`✗ refused on a fresh check: ${result.reason_code}. ${result.detail}`);
    break;
  case "REJECTED":
    console.log(`✗ ${result.reason}`);
    break;
  case "IN_FLIGHT":
    console.log(`… in flight: ${result.detail}`);
    break;
  case "NOT_FOUND":
    console.log(`✗ ${result.detail}`);
    break;
}
console.log(`  trace: ${deps.receiptBaseUrl}/r/${encodeURIComponent(approval.traceId)}`);
await prisma.$disconnect();
