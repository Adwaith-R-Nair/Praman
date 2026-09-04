import type { PrismaTx } from "@praman/db";
import { paise, type LedgerDerivedState } from "@praman/shared";

interface Row {
  seq: bigint;
  ts: Date;
  event_type: string;
  payload: Record<string, unknown>;
}

/**
 * Replays the ledger to derive a mandate's current state. D-03: spend is never
 * stored, because a stored counter is a number an attacker can edit. Deriving
 * it means inflating a budget requires forging every subsequent entry hash.
 *
 * Raw SQL so the (payload->>'mandate_id') expression index is actually used —
 * Prisma's JSON path filter emits jsonb equality, which would not hit it.
 */
export async function deriveState(tx: PrismaTx, mandateId: string): Promise<LedgerDerivedState> {
  const rows = await tx.$queryRaw<Row[]>`
    SELECT seq, ts, event_type, payload
    FROM ledger_entry
    WHERE payload->>'mandate_id' = ${mandateId}
    ORDER BY seq ASC
  `;

  let spent = 0n;
  let revoked = false;
  const txnTimestamps: Date[] = [];
  const deniedAttempts: Date[] = [];
  const merchants = new Set<string>();
  const keys = new Set<string>();

  for (const row of rows) {
    switch (row.event_type) {
      case "mandate_revoked":
        revoked = true;
        break;

      case "outcome": {
        // ONLY a captured payment moves spend. A decision is not a payment.
        // Counting decisions would let an attacker exhaust someone's budget
        // with proposals they know will be denied.
        if (row.payload["status"] !== "captured") break;

        const amount = row.payload["amount_paise"];
        if (typeof amount !== "string" || !/^\d+$/.test(amount)) {
          throw new TypeError(`ledger seq ${row.seq}: outcome amount_paise is malformed`);
        }
        spent += BigInt(amount);
        txnTimestamps.push(row.ts);

        const merchant = row.payload["merchant_id"];
        if (typeof merchant === "string") merchants.add(merchant);

        const key = row.payload["idempotency_key"];
        if (typeof key === "string") keys.add(key);
        break;
      }

      case "decision":
        if (row.payload["kind"] === "DENY") deniedAttempts.push(row.ts);
        break;

      default:
        break;
    }
  }

  return {
    spent_paise: paise(spent),
    txn_timestamps: txnTimestamps,
    revoked,
    merchants_transacted: merchants,
    seen_idempotency_keys: keys,
    denied_attempts: deniedAttempts,
  };
}
