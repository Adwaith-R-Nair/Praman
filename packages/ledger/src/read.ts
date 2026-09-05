import type { PrismaTx } from "@praman/db";
import type { EventType } from "./append.js";

export interface LedgerEntryRecord {
  readonly seq: bigint;
  readonly traceId: string;
  readonly ts: Date;
  readonly actor: string;
  readonly eventType: EventType;
  readonly payload: unknown;
  readonly payloadHash: string;
  readonly prevHash: string;
  readonly entryHash: string;
}

/**
 * Every entry for one trace, in the order they happened. This is the
 * receipt viewer's entire data layer — everything else it renders is
 * derived from this one read.
 */
export async function read(tx: PrismaTx, traceId: string): Promise<readonly LedgerEntryRecord[]> {
  const rows = await tx.ledgerEntry.findMany({
    where: { traceId },
    orderBy: { seq: "asc" },
  });
  return rows.map((r) => ({
    seq: r.seq,
    traceId: r.traceId,
    ts: r.ts,
    actor: r.actor,
    eventType: r.eventType as EventType,
    payload: r.payload,
    payloadHash: r.payloadHash,
    prevHash: r.prevHash,
    entryHash: r.entryHash,
  }));
}
