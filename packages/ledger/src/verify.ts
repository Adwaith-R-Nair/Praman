import type { PrismaTx } from "@praman/db";
import { computeEntryHash, computePayloadHash, GENESIS_HASH } from "./chain.js";
import { merkleRoot } from "./merkle.js";

export type VerifyResult =
  | { ok: true; checked: number; head: string }
  | { ok: false; brokenAt: bigint; reason: BreakReason; detail: string };

export type BreakReason =
  | "SEQ_GAP"
  | "PREV_MISMATCH"
  | "PAYLOAD_HASH_MISMATCH"
  | "ENTRY_HASH_MISMATCH"
  | "MERKLE_MISMATCH";

const BATCH = 1000;

/**
 * Walks the chain from genesis, recomputing every hash from stored fields.
 *
 * Fails fast at the FIRST break rather than collecting all of them: once the
 * chain is broken, every entry after it is unverifiable anyway, so a list of
 * "failures" would be one real finding plus noise.
 */
export async function verifyChain(tx: PrismaTx): Promise<VerifyResult> {
  let cursor = 0n;
  let expectedSeq = 1n;
  let prevHash = GENESIS_HASH;
  let checked = 0;
  let head = GENESIS_HASH;

  // Accumulated for checkpoint verification.
  let sinceCheckpoint: string[] = [];

  for (;;) {
    const rows = await tx.ledgerEntry.findMany({
      where: { seq: { gt: cursor } },
      orderBy: { seq: "asc" },
      take: BATCH,
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      if (row.seq !== expectedSeq) {
        return {
          ok: false,
          brokenAt: row.seq,
          reason: "SEQ_GAP",
          detail: `expected seq ${expectedSeq}, found ${row.seq}`,
        };
      }
      if (row.prevHash !== prevHash) {
        return {
          ok: false,
          brokenAt: row.seq,
          reason: "PREV_MISMATCH",
          detail: `prev_hash does not match the previous entry's hash`,
        };
      }

      const payloadHash = computePayloadHash(row.payload);
      if (payloadHash !== row.payloadHash) {
        return {
          ok: false,
          brokenAt: row.seq,
          reason: "PAYLOAD_HASH_MISMATCH",
          detail: `payload was modified after it was written`,
        };
      }

      const entryHash = computeEntryHash({
        prevHash: row.prevHash,
        seq: row.seq,
        ts: row.ts,
        actor: row.actor,
        eventType: row.eventType,
        payloadHash: row.payloadHash,
      });
      if (entryHash !== row.entryHash) {
        return {
          ok: false,
          brokenAt: row.seq,
          reason: "ENTRY_HASH_MISMATCH",
          detail: `entry fields were modified after they were written`,
        };
      }

      if (row.eventType === "checkpoint") {
        const payload = row.payload as Record<string, unknown>;
        const claimed = payload["merkle_root"];
        const actual = merkleRoot(sinceCheckpoint);
        if (claimed !== actual) {
          return {
            ok: false,
            brokenAt: row.seq,
            reason: "MERKLE_MISMATCH",
            detail: `checkpoint root ${String(claimed)} does not cover the preceding range`,
          };
        }
        sinceCheckpoint = [];
      } else {
        sinceCheckpoint.push(row.entryHash);
      }

      prevHash = row.entryHash;
      head = row.entryHash;
      cursor = row.seq;
      expectedSeq = row.seq + 1n;
      checked += 1;
    }
  }

  return { ok: true, checked, head };
}
