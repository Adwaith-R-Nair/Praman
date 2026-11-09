import { readAmount, readCurrency, type LedgerEntryRecord } from "@praman/ledger";
import { minorFromJSON, type Currency, type Minor } from "@praman/shared";

/**
 * What the ledger's outcome rows add up to for one order. A capture beats everything,
 * as in deriveState (D-30). A mismatch row is the ledger saying the rail reported
 * different money (D-33). "failed" means only failed rows name this order.
 */
export type LedgerOrderStatus = "captured" | "mismatch" | "released" | "created" | "failed";

export interface LedgerRefund {
  /**
   * "requested": a refund was asked for and no outcome is on the ledger yet.
   * "none": no refund, or only failed ones, which moved no money.
   */
  readonly state: "none" | "requested" | "pending" | "refunded" | "mismatch";
  readonly refundId: string | null;
  readonly amountMinor: Minor | null;
  readonly currency: Currency | null;
}

export interface LedgerOrder {
  readonly orderId: string;
  readonly status: LedgerOrderStatus;
  /** The captured amount once captured, the amount held before that. Null when the ledger's own rows disagree. */
  readonly amountMinor: Minor | null;
  readonly currency: Currency;
  /** The rail's payment id on the captured row: PayPal's capture id. */
  readonly captureId: string | null;
  readonly refund: LedgerRefund;
}

export type LedgerTrace =
  | { readonly kind: "empty" }
  /** Rows exist, and none records an order on the PayPal rail. */
  | { readonly kind: "no_paypal_order"; readonly rails: readonly string[]; readonly ordersOnOtherRails: number }
  | { readonly kind: "paypal"; readonly orders: readonly LedgerOrder[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

interface Row {
  readonly seq: bigint;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
}

interface Money {
  readonly amountMinor: Minor;
  readonly currency: Currency;
}

function moneyOf(row: Row): Money {
  return { amountMinor: minorFromJSON(readAmount(row.payload, row.seq)), currency: readCurrency(row.payload) };
}

/**
 * The newest refund attempt whose own latest row isn't a failure, the same rule the
 * control plane applies before it starts a refund (D-66). A failed refund moved no
 * money, so it doesn't count.
 */
function refundOf(rows: readonly Row[], orderId: string): LedgerRefund {
  const about = rows.filter((row) => row.payload["order_id"] === orderId);
  const outcomes = about.filter((row) => row.eventType === "refund_outcome");
  const latestSeen = new Set<string | null>();
  for (const row of [...outcomes].reverse()) {
    const key = str(row.payload["refund_key"]);
    if (latestSeen.has(key)) continue;
    latestSeen.add(key);
    const status = row.payload["status"];
    if (status === "failed") continue;
    if (status !== "refunded" && status !== "pending" && status !== "mismatch") {
      throw new TypeError(`ledger seq ${row.seq}: refund outcome has an unknown status`);
    }
    const money = moneyOf(row);
    return { state: status, refundId: str(row.payload["refund_id"]), amountMinor: money.amountMinor, currency: money.currency };
  }
  const unanswered = about.some((row) => row.eventType === "refund_requested" && !latestSeen.has(str(row.payload["refund_key"])));
  return { state: unanswered ? "requested" : "none", refundId: null, amountMinor: null, currency: null };
}

function orderOf(orderId: string, outcomes: readonly Row[], all: readonly Row[]): LedgerOrder {
  const withStatus = (status: string): Row[] => outcomes.filter((row) => row.payload["status"] === status);
  const refund = refundOf(all, orderId);

  const captured = withStatus("captured")[0];
  if (captured !== undefined) {
    return { orderId, status: "captured", ...moneyOf(captured), captureId: str(captured.payload["payment_id"]), refund };
  }

  const status: LedgerOrderStatus =
    withStatus("mismatch").length > 0 ? "mismatch" : withStatus("released").length > 0 ? "released" : withStatus("created").length > 0 ? "created" : "failed";
  // A release row carries no amount. Every other row says what Praman asked for.
  const priced = outcomes.filter((row) => row.payload["status"] !== "released").map(moneyOf);
  const first = priced[0];
  if (first === undefined) throw new TypeError(`ledger: order ${orderId} has no row with an amount`);
  const agree = priced.every((money) => money.amountMinor === first.amountMinor && money.currency === first.currency);
  return { orderId, status, amountMinor: agree ? first.amountMinor : null, currency: first.currency, captureId: null, refund };
}

/**
 * Reads one trace's ledger rows for the orders it made on the PayPal rail. Only
 * rows are read, never the outbox record, because the ledger is the evidence.
 * Throws a TypeError on a row it can't read, rather than guessing at money.
 */
export function viewTrace(entries: readonly LedgerEntryRecord[]): LedgerTrace {
  if (entries.length === 0) return { kind: "empty" };
  const rows: Row[] = entries.flatMap((entry) => (isRecord(entry.payload) ? [{ seq: entry.seq, eventType: entry.eventType, payload: entry.payload }] : []));

  const rails = new Set<string>();
  const paypalOrders = new Map<string, Row[]>();
  const otherOrders = new Set<string>();
  for (const row of rows) {
    const rail = str(row.payload["rail"]);
    if (rail !== null) rails.add(rail);
    if (row.eventType !== "outcome") continue;
    const orderId = str(row.payload["order_id"]);
    if (orderId === null) continue;
    if (rail !== "paypal") {
      otherOrders.add(orderId);
      continue;
    }
    paypalOrders.set(orderId, [...(paypalOrders.get(orderId) ?? []), row]);
  }

  if (paypalOrders.size === 0) return { kind: "no_paypal_order", rails: [...rails].sort(), ordersOnOtherRails: otherOrders.size };
  return { kind: "paypal", orders: [...paypalOrders].map(([orderId, outcomes]) => orderOf(orderId, outcomes, rows)) };
}
