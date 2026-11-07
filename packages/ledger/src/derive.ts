import type { PrismaTx } from "@praman/db";
import { isCurrency, minor, type Currency, type LedgerDerivedState } from "@praman/shared";

interface Row {
  seq: bigint;
  ts: Date;
  trace_id: string;
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
 * What one outcome row holds of the budget. On a mismatch, amount_minor is what
 * Praman authorised and rail_amount_minor is what the rail reported. A rail
 * reporting less can't free budget, and one reporting more is counted at more,
 * the same rule as two rows disagreeing. In another currency the two numbers
 * can't be compared, so the authorised one stands (D-33).
 */
function heldAmount(payload: Record<string, unknown>, seq: bigint): bigint {
  const authorised = BigInt(readAmount(payload, seq));
  const reported = payload["rail_amount_minor"];
  if (reported === undefined || payload["rail_currency"] !== payload["currency"]) return authorised;
  const amount = BigInt(readAmount({ amount_minor: reported }, seq));
  return amount > authorised ? amount : authorised;
}

/** One outcome row that counts toward an order. A release has no amount of its own. */
interface OrderRow {
  readonly ts: Date;
  readonly orderId: string | null;
  readonly status: string;
  readonly amount: bigint;
  readonly merchant: string | null;
}

/** Everything the outcomes for one order add up to. See deriveState. */
interface OrderFold {
  readonly firstSeen: Date;
  amount: bigint;
  readonly merchants: string[];
  captured: boolean;
  released: boolean;
  mismatch: boolean;
}

function newOrderFold(firstSeen: Date): OrderFold {
  return { firstSeen, amount: 0n, merchants: [], captured: false, released: false, mismatch: false };
}

/**
 * Splits one key's rows into the orders they are about. The same order id is the
 * same order, however many rows name it, so a reconciler racing T2 counts once.
 * Two order ids are two orders: a rail isn't trusted to enforce the key (D-22), and
 * each one that exists is an obligation (D-34).
 *
 * A row with no order id belongs to the key's order, which is how every old row
 * always counted. If the key has several, it joins the first rather than inventing
 * another, unless it is a release. A release that can't say which order it means
 * frees nothing.
 */
function foldOrders(rows: readonly OrderRow[]): OrderFold[] {
  const orderIds = [...new Set(rows.flatMap((row) => row.orderId ?? []))];
  const several = orderIds.length > 1;
  const folds = new Map<string, OrderFold>();

  for (const row of rows) {
    if (several && row.orderId === null && row.status === "released") continue;
    const foldId = (several ? row.orderId : null) ?? orderIds[0] ?? "";
    const order = folds.get(foldId) ?? newOrderFold(row.ts);
    folds.set(foldId, order);

    // These should always agree. If they don't, the higher one is counted,
    // so a mismatch can't free budget. Throwing would be worse: this row
    // can never be rewritten, so it would break the mandate permanently.
    if (row.amount > order.amount) order.amount = row.amount;
    if (row.status === "captured") order.captured = true;
    if (row.status === "released") order.released = true;
    if (row.status === "mismatch") order.mismatch = true;
    if (row.merchant !== null) order.merchants.push(row.merchant);
  }
  return [...folds.values()];
}

/** A call T1 recorded before going to the rail. Held until an outcome answers it. */
interface Attempt {
  readonly seq: bigint;
  readonly ts: Date;
  readonly traceId: string;
  readonly key: string | null;
  readonly payload: Record<string, unknown>;
}

/**
 * Replays the ledger to derive a mandate's current state. D-03: spend is never
 * stored, because a stored counter is a number an attacker can edit. Deriving
 * it means inflating a budget requires forging every subsequent entry hash.
 *
 * An order create that T1 recorded and no outcome has answered yet is reserved:
 * it counts toward spend and velocity, because the rail may have made the order
 * (D-42). It earns the merchant no trust, since it may not exist.
 *
 * Raw SQL so the (payload->>'mandate_id') expression index is actually used —
 * Prisma's JSON path filter emits jsonb equality, which would not hit it.
 */
export async function deriveState(tx: PrismaTx, mandateId: string): Promise<LedgerDerivedState> {
  const rows = await tx.$queryRaw<Row[]>`
    SELECT seq, ts, trace_id, event_type, payload
    FROM ledger_entry
    WHERE payload->>'mandate_id' = ${mandateId}
    ORDER BY seq ASC
  `;

  let revoked = false;
  const deniedAttempts: Date[] = [];
  const keys = new Set<string>();
  const releasedKeys = new Set<string>();
  const attempts: Attempt[] = [];
  // Every outcome answers its attempt, failed ones included. Old api_call rows have
  // no key, so they are answered by any outcome on their trace (D-42).
  const answeredKeys = new Set<string>();
  const answeredTraces = new Set<string>();

  // One order can have several outcomes: created, then captured later, or a
  // release. They are one purchase, so rows are grouped by key, and split into
  // orders by foldOrders, before anything is counted (D-30, D-34). An old outcome
  // with no key can't be matched to anything, so it stays its own order, which is
  // what it always counted as.
  const groups: OrderRow[][] = [];
  const groupsByKey = new Map<string, OrderRow[]>();
  const groupFor = (key: string): OrderRow[] => {
    const existing = groupsByKey.get(key);
    if (existing !== undefined) return existing;
    const group: OrderRow[] = [];
    groupsByKey.set(key, group);
    groups.push(group);
    return group;
  };

  for (const row of rows) {
    switch (row.event_type) {
      case "mandate_revoked":
        revoked = true;
        break;

      case "api_call": {
        // A capture is a call about an order that already holds its budget, so it
        // reserves nothing more. Anything else that was attempted might have made an
        // order, including an operation this code doesn't know, which fails closed.
        if (row.payload["status"] !== "attempted" || row.payload["operation"] === "orders.capture") break;
        const key = row.payload["idempotency_key"];
        attempts.push({ seq: row.seq, ts: row.ts, traceId: row.trace_id, key: typeof key === "string" ? key : null, payload: row.payload });
        break;
      }

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
        answeredTraces.add(row.trace_id);
        if (typeof key === "string") answeredKeys.add(key);
        const rawOrderId = row.payload["order_id"];
        const orderId = typeof rawOrderId === "string" ? rawOrderId : null;

        if (status === "released") {
          if (typeof key !== "string") break;
          keys.add(key);
          releasedKeys.add(key);
          groupFor(key).push({ ts: row.ts, orderId, status, amount: 0n, merchant: null });
          break;
        }

        // A "mismatch" is an order that exists but isn't the one that was asked
        // for. It is still an obligation, so it holds budget and velocity like
        // any order. See the counting below for what it doesn't get (D-33).
        if (status !== "created" && status !== "captured" && status !== "mismatch") break;

        const merchant = row.payload["merchant_id"];
        const orderRow: OrderRow = {
          ts: row.ts,
          orderId,
          status,
          amount: heldAmount(row.payload, row.seq),
          merchant: typeof merchant === "string" ? merchant : null,
        };
        if (typeof key === "string") {
          keys.add(key);
          groupFor(key).push(orderRow);
        } else {
          groups.push([orderRow]);
        }
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
  for (const order of groups.flatMap(foldOrders)) {
    // Velocity counts attempts, so a released order still used one up.
    txnTimestamps.push(order.firstSeen);

    // A release only frees an order whose money didn't move. If a capture is
    // on record too, that money is gone, whichever row came first.
    // The same goes for a mismatch, since the rail's word on it can't be trusted.
    if (order.released && !order.captured && !order.mismatch) continue;

    spent += order.amount;

    // An order that came back wrong is no reason to trust the merchant next time.
    if (order.mismatch) continue;
    for (const merchant of order.merchants) merchants.add(merchant);
  }

  // An attempt with a key pairs only by key, because two attempts can share a trace.
  for (const attempt of attempts) {
    const answered = attempt.key !== null ? answeredKeys.has(attempt.key) : answeredTraces.has(attempt.traceId);
    if (answered) continue;
    spent += BigInt(readAmount(attempt.payload, attempt.seq));
    txnTimestamps.push(attempt.ts);
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
