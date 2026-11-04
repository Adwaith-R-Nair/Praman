import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import type { SignedMandate } from "@praman/mandate";

// @praman/db throws at import time if DATABASE_URL is unset, and static
// imports are hoisted above a module's own top-level code — so loading dotenv
// has to happen before a DYNAMIC import of @praman/db (via @praman/control-plane
// and @praman/razorpay-exec), not a static one. Same fix as verify-ledger.ts.
config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

const approvalId = process.argv[2];
const verdict = process.argv[3];
if (approvalId === undefined || (verdict !== "approve" && verdict !== "reject")) {
  console.error("usage: pnpm approve <approval_id> approve|reject");
  process.exit(1);
}

const publicKeyB64 = process.env["MANDATE_PUBLIC_KEY"];
if (!publicKeyB64) throw new Error("MANDATE_PUBLIC_KEY is not set");
const publicKeyPem = Buffer.from(publicKeyB64, "base64").toString("utf8");

const mandatePath = fileURLToPath(new URL("../mandate.json", import.meta.url));
const signed = JSON.parse(readFileSync(mandatePath, "utf8")) as SignedMandate;

const { resolveApproval } = await import("@praman/control-plane");
const { routeAllTo, routeByRail, SimulatedExecutor } = await import("@praman/exec-core");
const { LiveExecutor } = await import("@praman/razorpay-exec");
const { prisma } = await import("@praman/db");

const live = process.env["PRAMAN_LIVE"] === "1";
// Live pays only on the merchant's own rail, and refuses a merchant on any other.
const route = live
  ? routeByRail([new LiveExecutor(process.env["RAZORPAY_KEY_ID"] ?? "", process.env["RAZORPAY_KEY_SECRET"] ?? "")])
  : routeAllTo(new SimulatedExecutor());

console.log(`▸ ${verdict === "approve" ? "approving" : "rejecting"} ${approvalId}${live ? " (LIVE)" : ""}...\n`);

const result = await resolveApproval(approvalId, verdict, signed, publicKeyPem, route, new Date());

switch (result.kind) {
  case "EXECUTED":
    if (result.order_status === "failed") {
      console.log(`✗ the rail did not take this order — ${result.order_id || "no order exists"} (failed)`);
    } else {
      console.log(`✓ executed — order ${result.order_id} (${result.order_status})`);
    }
    console.log(`  trace: ${result.trace_id}`);
    break;
  case "REFUSED":
    console.log(`✗ refused — ${result.reason_code}`);
    console.log(`  ${result.detail}`);
    break;
  case "REJECTED":
    console.log(`✗ ${result.reason}`);
    break;
  case "IN_FLIGHT":
    console.log(`… in flight — ${result.detail}`);
    break;
  case "NOT_FOUND":
    console.log(`✗ no approval found: ${result.detail}`);
    break;
}

await prisma.$disconnect();
process.exit(result.kind === "EXECUTED" && result.order_status !== "failed" ? 0 : 1);
