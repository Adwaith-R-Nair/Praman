import type { PrismaTx } from "@praman/db";
import { isCurrency, minor, type Currency, type LedgerDerivedState } from "@praman/shared";

interface Row {
  seq: bigint;
  ts: Date;
  event_type: string;
  payload: Record<string, unknown>;
}

/**
 * Ledger rows are never rewritten, so rows from before the rename to minor
 * units say `amount_paise` for as long as the ledger exists, and their hashes
 * cover that exact name. Every reader goes through one of these two functions.
 *
 * This one is for anything that counts money, and it refuses rather than
 * guesses: no amount, a malformed amount, or two amounts that disagree.
 */
export function readAmount(payload: Record<string, unknown>, seq: bigint): string {
  const present = ["amount_minor", "amount_paise"].filter((field) => payload[field] !== undefined);
  const [field, other] = present;
  if (field === undefined) throw new TypeError(`ledger seq ${seq}: outcome has no amount`);
  if (other !== undefined && payload[field] !== payload[other]) {
    throw new TypeError(`ledger seq ${seq}: outcome amounts disagree`);
  }
  const amount = payload[field];
  if (typeof amount !== "string" || !/^\d+$/.test(amount)) {
    throw new TypeError(`ledger seq ${seq}: outcome ${field} is malformed`);
  }
  return amount;
}

/**
 * For showing a trace, where having no amount is normal: a DENY decision has
 * none. Never use this to count money. Use readAmount.
 */
export function amountIfPresent(payload: Record<string, unknown>): string | null {
  for (const value of [payload["amount_minor"], payload["amount_paise"]]) {
    if (typeof value === "string") return value;
  }
  return null;
}

/**
 * The currency of an entry's amount. Ledger rows are never rewritten, and rows
 * written before USD existed have no currency field. They are INR, because
 * evaluate() refused everything else at the time. A value we don't recognise is
 * refused, not displayed as if it were money.
 */
export function readCurrency(payload: Record<string, unknown>): Currency {
  const currency = payload["currency"];
  if (currency === undefined) return "INR";
  if (!isCurrency(currency)) throw new TypeError(`ledger entry has an unknown currency: ${String(currency)}`);
  return currency;
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
        // A CREATED order moves spend, not only a captured one. An order
        // that exists is a payable obligation the mandate authorised —
        // Praman's authority to refuse ended when it was created (D-17).
        // LiveExecutor returns "created" immediately and only becomes
        // "captured" later via reconciliation; counting only "captured"
        // would let a mandate create unlimited orders while its budget
        // never moved. A decision is still not a payment — only outcome
        // events reach this case at all.
        const status = row.payload["status"];
        if (status !== "created" && status !== "captured") break;

        spent += BigInt(readAmount(row.payload, row.seq));
        txnTimestamps.push(row.ts);

        const merchant = row.payload["merchant_id"];
        if (typeof merchant === "string") merchants.add(merchant);

        const key = row.payload["idempotency_key"];
        if (typeof key === "string") keys.add(key);
        break;
      }

      case "decision":
        // A signature-invalid DENY never proved the caller owns this mandate_id
        // — it's an unverified claim, not a real denied attempt by the holder.
        // The ledger is append-only, so old entries in this shape can't be
        // rewritten; this is corrected on the read side instead. See D-xx.
        if (row.payload["kind"] === "DENY" && row.payload["reason_code"] !== "MANDATE_SIGNATURE_INVALID") {
          deniedAttempts.push(row.ts);
        }
        break;

      default:
        break;
    }
  }

  return {
    spent_minor: minor(spent),
    txn_timestamps: txnTimestamps,
    revoked,
    merchants_transacted: merchants,
    seen_idempotency_keys: keys,
    denied_attempts: deniedAttempts,
  };
}
