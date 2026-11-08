import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// Same reason as approve.ts: dotenv must load before any dynamic import reaches @praman/db.
config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

const traceId = process.argv[2];
if (traceId === undefined || traceId === "") {
  console.error("usage: pnpm refund <trace_id>");
  process.exit(1);
}

const { refundOrder } = await import("@praman/control-plane");
const { routeByRail } = await import("@praman/exec-core");
const { PayPalExecutor, PAYPAL_SANDBOX_BASE_URL } = await import("@praman/paypal-exec");
const { prisma } = await import("@praman/db");
const { formatMoney } = await import("@praman/shared");
type Executor = import("@praman/exec-core").Executor;

// Only a person runs this (D-66). PayPal is the one rail here that can refund: Razorpay
// stops at order creation in this repo, and the simulator has nothing to give back.
const executors: Executor[] = [];
const ppId = process.env["PAYPAL_CLIENT_ID"];
const ppSecret = process.env["PAYPAL_CLIENT_SECRET"];
if (ppId && ppSecret) executors.push(new PayPalExecutor({ clientId: ppId, clientSecret: ppSecret, baseUrl: PAYPAL_SANDBOX_BASE_URL, fetch: globalThis.fetch }));

console.log(`▸ refunding the paid order on ${traceId}${executors.length === 0 ? " (no PayPal keys in .env, so no rail can refund)" : ""}...\n`);

const result = await refundOrder({ traceId, mandateIds: null, requestedBy: "operator" }, routeByRail(executors), new Date());

switch (result.kind) {
  case "REFUNDED":
    console.log(`✓ refunded ${formatMoney(result.amount_minor, result.currency)} to the buyer: refund ${result.refund_id ?? "(no id)"}`);
    console.log(`  order ${result.order_id}, capture ${result.payment_id}`);
    console.log("  the mandate's budget still counts this purchase: a refund gives money back, not spending room (D-67)");
    break;
  case "PENDING":
    console.log(`… the payment provider accepted refund ${result.refund_id ?? "(no id)"} and hasn't finished it. pnpm reconcile follows it up.`);
    break;
  case "FAILED":
    console.log(`✗ the payment provider refused the refund: ${result.failure_code ?? "no code"}. No money went back.`);
    break;
  case "MISMATCH":
    console.log(`✗ ${result.detail}`);
    break;
  case "IN_FLIGHT":
    console.log(`… ${result.detail}`);
    break;
  case "CANNOT_REFUND":
    console.log(`✗ nothing refunded (${result.why}): ${result.detail}`);
    break;
}
console.log(`  trace: ${result.trace_id}`);

await prisma.$disconnect();
process.exit(result.kind === "REFUNDED" ? 0 : 1);
