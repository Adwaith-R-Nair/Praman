import type { PrismaTx } from "@praman/db";
import { append } from "./append.js";
import { merkleRoot } from "./merkle.js";

export const CHECKPOINT_INTERVAL = 100n;

/**
 * Appends a checkpoint entry containing the Merkle root over the entries since
 * the previous checkpoint. The checkpoint is itself a chain entry, so it is
 * hashed and linked like any other; its payload covers the range BEFORE it.
 *
 * In production the root would be anchored externally — published somewhere the
 * database operator does not control — so that rewriting the whole chain still
 * cannot match a previously published root. Not anchored here; stated as a
 * limitation rather than implied.
 */
export async function maybeCheckpoint(tx: PrismaTx, now: Date): Promise<string | null> {
  const last = await tx.ledgerEntry.findFirst({
    where: { eventType: "checkpoint" },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });

  const fromSeq = (last?.seq ?? 0n) + 1n;

  const range = await tx.ledgerEntry.findMany({
    where: { seq: { gte: fromSeq } },
    orderBy: { seq: "asc" },
    select: { seq: true, entryHash: true },
  });

  if (BigInt(range.length) < CHECKPOINT_INTERVAL) return null;

  const root = merkleRoot(range.map((r) => r.entryHash));
  const toSeq = range[range.length - 1]!.seq;

  await append(tx, {
    traceId: `ckpt_${toSeq.toString()}`,
    ts: now,
    actor: "system",
    eventType: "checkpoint",
    payload: {
      merkle_root: root,
      from_seq: fromSeq.toString(),
      to_seq: toSeq.toString(),
      count: range.length,
    },
  });

  return root;
}
