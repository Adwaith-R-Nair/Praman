import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// Same reason as approve.ts and verify-ledger.ts — dotenv must load before
// any dynamic import reaches @praman/db.
config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

const mandateId = process.argv[2];
const reason = process.argv[3];
if (!mandateId || !reason) {
  console.error('usage: pnpm revoke <mandate_id> "<reason>"');
  process.exit(1);
}

const { prisma } = await import("@praman/db");
const { revokeMandate } = await import("@praman/control-plane");

const now = new Date();
// Takes the same per-mandate lock run-intent.ts and resolve-approval.ts use, so a
// revocation racing an in-flight intent commits before that intent's own transaction
// can read this mandate's state, not after. The demo's revoke step calls the same function.
await revokeMandate({ mandateId, reason, traceId: `trc_revoke_${now.getTime()}`, now });

console.log(`✓ revoked ${mandateId}`);
console.log(`  reason: ${reason}`);

await prisma.$disconnect();
