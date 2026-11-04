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

/** Everything the outcomes for one order add up to. See deriveState. */
interface OrderFold {
  readonly firstSeen: Date;
  amount: bigint;
  readonly merchants: string[];
  captured: boolean;
  released: boolean;
}

function newOrderFold(firstSeen: Date): OrderFold {
  return { firstSeen, amount: 0n, merchants: [], captured: false, released: false };
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

  let revoked = false;
  const deniedAttempts: Date[] = [];
  const keys = new Set<string>();
  const releasedKeys = new Set<string>();

  // One order can have several outcomes: created, then captured later, or a
  // release. They are one purchase, so they are folded together by key before
  // anything is counted (D-30). An old outcome with no key can't be matched to
  // anything, so it stays its own order, which is what it always counted as.
  const orders: OrderFold[] = [];
  const ordersByKey = new Map<string, OrderFold>();
  const orderFor = (key: string, ts: Date): OrderFold => {
    const existing = ordersByKey.get(key);
    if (existing !== undefined) return existing;
    const order = newOrderFold(ts);
    ordersByKey.set(key, order);
    orders.push(order);
    return order;
  };

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
        //
        // A "released" order is a PayPal checkout nobody approved in time. It
        // gives the budget back. It stays in `keys`, because the rail would
        // answer a repeat of this key with the same old order. A release with
        // no key can't name an order, so it frees nothing.
        const status = row.payload["status"];
        const key = row.payload["idempotency_key"];

        if (status === "released") {
          if (typeof key !== "string") break;
          keys.add(key);
          releasedKeys.add(key);
          orderFor(key, row.ts).released = true;
          break;
        }

        if (status !== "created" && status !== "captured") break;

        const amount = BigInt(readAmount(row.payload, row.seq));
        let order: OrderFold;
        if (typeof key === "string") {
          keys.add(key);
          order = orderFor(key, row.ts);
        } else {
          order = newOrderFold(row.ts);
          orders.push(order);
        }

        // These should always agree. If they don't, the higher one is counted,
        // so a mismatch can't free budget. Throwing would be worse: this row
        // can never be rewritten, so it would break the mandate permanently.
        if (amount > order.amount) order.amount = amount;
        if (status === "captured") order.captured = true;

        const merchant = row.payload["merchant_id"];
        if (typeof merchant === "string") order.merchants.push(merchant);
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

  let spent = 0n;
  const txnTimestamps: Date[] = [];
  const merchants = new Set<string>();

  // Done after the replay, so the order the rows arrived in can't matter.
  for (const order of orders) {
    // Velocity counts attempts, so a released order still used one up.
    txnTimestamps.push(order.firstSeen);

    // A release only frees an order whose money didn't move. If a capture is
    // on record too, that money is gone, whichever row came first.
    if (order.released && !order.captured) continue;

    spent += order.amount;
    for (const merchant of order.merchants) merchants.add(merchant);
  }

  return {
    spent_minor: minor(spent),
    txn_timestamps: txnTimestamps,
    revoked,
    merchants_transacted: merchants,
    seen_idempotency_keys: keys,
    released_keys: releasedKeys,
    denied_attempts: deniedAttempts,
  };
}
