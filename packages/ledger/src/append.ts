import type { PrismaTx } from "@praman/db";
import { canonical } from "@praman/shared";
import { computeEntryHash, computePayloadHash, GENESIS_HASH } from "./chain.js";
import { assertLedgerPayload } from "./payload.js";

export type EventType =
  | "intent" | "decision" | "step_up_resolved"
  | "api_call" | "outcome" | "mandate_revoked" | "checkpoint";

/** Arbitrary but fixed. One lock guards the whole chain. */
const LEDGER_LOCK_ID = 918_273_645n;

export interface AppendInput {
  readonly traceId: string;
  readonly ts: Date;
  readonly actor: string;
  readonly eventType: EventType;
  readonly payload: unknown;
}

export interface AppendedEntry {
  readonly seq: bigint;
  readonly prevHash: string;
  readonly entryHash: string;
  readonly payloadHash: string;
}

/**
 * Appends one entry to the hash chain.
 *
 * Takes the CALLER's transaction. Never opens its own — the ledger write and
 * the action it records must commit together or not at all. A captured payment
 * with no ledger entry is the worst state this system can reach.
 */
export async function append(tx: PrismaTx, e: AppendInput): Promise<AppendedEntry> {
  assertLedgerPayload(e.payload);
  if (Number.isNaN(e.ts.getTime())) throw new RangeError("append: ts is an invalid Date");

  // The chain is a single linked list, so appends cannot proceed in parallel:
  // two concurrent writers would read the same head and fork it. This lock is
  // global rather than per-mandate for that reason, and it is released
  // automatically at commit or rollback.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(${LEDGER_LOCK_ID})`;

  const head = await tx.ledgerEntry.findFirst({
    orderBy: { seq: "desc" },
    select: { seq: true, entryHash: true },
  });

  const prevHash = head?.entryHash ?? GENESIS_HASH;
  const seq = head === null ? 1n : head.seq + 1n;

  const payloadHash = computePayloadHash(e.payload);
  const entryHash = computeEntryHash({
    prevHash,
    seq,
    ts: e.ts,
    actor: e.actor,
    eventType: e.eventType,
    payloadHash,
  });

  await tx.ledgerEntry.create({
    data: {
      seq,
      traceId: e.traceId,
      ts: e.ts,
      actor: e.actor,
      eventType: e.eventType,
      payload: JSON.parse(canonical(e.payload)) as object,
      payloadHash,
      prevHash,
      entryHash,
    },
  });

  return { seq, prevHash, entryHash, payloadHash };
}
