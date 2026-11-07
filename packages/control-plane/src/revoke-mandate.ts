import { prisma } from "@praman/db";
import { append, maybeCheckpoint } from "@praman/ledger";
import { MANDATE_LOCK_NS } from "./run-intent.js";

export interface Revocation {
  readonly mandateId: string;
  /** Why, in the issuer's words. Stored on the ledger as evidence, never read by policy. */
  readonly reason: string;
  /** The trace the revocation row goes on. A revocation is its own trace, not part of a purchase. */
  readonly traceId: string;
  readonly now: Date;
}

/**
 * Withdraws a mandate's authority by appending a mandate_revoked row. deriveState()
 * reads it, so evaluate() refuses every later intent MANDATE_REVOKED, and the capture
 * and approval re-checks refuse too (D-24, D-31). Nothing is updated or deleted: the
 * revocation is one more row on the chain.
 *
 * It takes the same per-mandate lock runIntent and resolveApproval take, so a
 * revocation racing an intent in flight commits before that intent's transaction reads
 * the mandate's state, not after. Used by `pnpm revoke` and by the demo's revoke step.
 */
export async function revokeMandate(revocation: Revocation): Promise<{ readonly seq: bigint }> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MANDATE_LOCK_NS}, hashtext(${revocation.mandateId}))`;
    const entry = await append(tx, {
      traceId: revocation.traceId,
      ts: revocation.now,
      actor: "issuer",
      eventType: "mandate_revoked",
      payload: { mandate_id: revocation.mandateId, reason: revocation.reason },
    });
    await maybeCheckpoint(tx, revocation.now);
    return { seq: entry.seq };
  });
}
