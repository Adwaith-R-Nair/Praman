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
const { append, maybeCheckpoint } = await import("@praman/ledger");
const { MANDATE_LOCK_NS } = await import("@praman/control-plane");

const now = new Date();
const traceId = `trc_revoke_${now.getTime()}`;

await prisma.$transaction(async (tx) => {
  // Same per-mandate serialisation run-intent.ts and resolve-approval.ts use —
  // a revocation racing an in-flight intent must commit before that intent's
  // own transaction can read this mandate's state, not after.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MANDATE_LOCK_NS}, hashtext(${mandateId}))`;

  await append(tx, {
    traceId,
    ts: now,
    actor: "issuer",
    eventType: "mandate_revoked",
    payload: { mandate_id: mandateId, reason },
  });

  await maybeCheckpoint(tx, now);
});

console.log(`✓ revoked ${mandateId}`);
console.log(`  reason: ${reason}`);

await prisma.$disconnect();
