import type { LedgerOrder, LedgerOrderStatus } from "./ledger-view.js";
import type { PayPalCapture, PayPalMoney, PayPalOrder, PayPalRefund } from "./paypal-view.js";

export type FieldResult = "MATCH" | "MISMATCH";

/** One compared field: what each side says, as it will be printed, and whether they agree. */
export interface FieldCheck {
  readonly field: string;
  readonly ledger: string;
  readonly paypal: string;
  readonly result: FieldResult;
}

/** PayPal's answer to get_refund for the refund the ledger names. "absent": PayPal has no refund with that id. */
export type RefundLookup = { readonly kind: "found"; readonly refund: PayPalRefund } | { readonly kind: "absent" } | { readonly kind: "not_asked" };

/**
 * Where the money stands at PayPal, by the table paypal-exec's executor uses
 * to read an order:
 *
 *   CREATED, PAYER_ACTION_REQUIRED, APPROVED       open: an order with no payment
 *   VOIDED, or a DECLINED or FAILED capture        dead: nothing was or can be paid
 *   COMPLETED with one finished capture            paid
 *   COMPLETED with a PENDING capture               unsettled
 *   anything else                                  unknown
 */
type PayPalState = "open" | "paid" | "dead" | "unsettled" | "unknown";

const PAID_CAPTURE: readonly string[] = ["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"];

function stateOf(order: PayPalOrder): PayPalState {
  switch (order.status) {
    case "CREATED":
    case "PAYER_ACTION_REQUIRED":
    case "APPROVED":
      return "open";
    case "VOIDED":
      return "dead";
    case "COMPLETED": {
      const [capture, another] = order.captures;
      if (capture === undefined || another !== undefined || capture.status === null) return "unknown";
      if (PAID_CAPTURE.includes(capture.status)) return "paid";
      if (capture.status === "DECLINED" || capture.status === "FAILED") return "dead";
      return capture.status === "PENDING" ? "unsettled" : "unknown";
    }
    default:
      return "unknown";
  }
}

/**
 * Which PayPal states agree with each ledger status. A released or failed order
 * took no money, so PayPal may still hold it open or have closed it. A mismatch row
 * agrees with nothing: the ledger itself says PayPal reported different money.
 */
const AGREES: Readonly<Record<LedgerOrderStatus, readonly PayPalState[]>> = {
  captured: ["paid"],
  created: ["open"],
  released: ["open", "dead"],
  failed: ["open", "dead"],
  mismatch: [],
};

const verdict = (same: boolean): FieldResult => (same ? "MATCH" : "MISMATCH");
const shown = (value: string | null): string => value ?? "(unreadable)";

/** The capture that took the money, when there is exactly one. */
function paidCapture(order: PayPalOrder): PayPalCapture | null {
  return stateOf(order) === "paid" ? (order.captures[0] ?? null) : null;
}

function showMoney(money: PayPalMoney): string {
  return `${money.amountMinor === null ? "(unreadable)" : money.amountMinor.toString()} ${shown(money.currencyCode)}`;
}

function refundChecks(ledger: LedgerOrder, paypal: PayPalOrder, lookup: RefundLookup): FieldCheck[] {
  const { refund } = ledger;
  // A refund PayPal lists that took, or is taking, money back. A failed or cancelled one moved nothing.
  const live = paypal.refunds.filter((r) => r.status === "COMPLETED" || r.status === "PENDING");
  const captureStatus = paidCapture(paypal)?.status ?? null;

  if (refund.state === "none" || refund.state === "requested") {
    const none = live.length === 0 && captureStatus !== "REFUNDED" && captureStatus !== "PARTIALLY_REFUNDED";
    return [
      {
        field: "refund_state",
        ledger: refund.state === "none" ? "none" : "requested, no outcome recorded",
        paypal: none ? "none" : `${live.length} refund(s) listed, capture ${shown(captureStatus)}`,
        result: verdict(none),
      },
    ];
  }

  const named = `${refund.state} ${refund.refundId ?? "(no id)"}`;
  if (lookup.kind !== "found") {
    return [{ field: "refund_state", ledger: named, paypal: lookup.kind === "absent" ? "no refund with this id" : "not read, the ledger has no refund id", result: "MISMATCH" }];
  }

  const found = lookup.refund;
  const others = live.filter((r) => r.id !== refund.refundId).length;
  // A refund the ledger records as a mismatch (D-68) agrees with nothing PayPal can say.
  const wanted = refund.state === "refunded" ? "COMPLETED" : refund.state === "pending" ? "PENDING" : null;
  const stateAgrees =
    wanted !== null && found.id === refund.refundId && found.status === wanted && (found.captureId === null || found.captureId === ledger.captureId) && others === 0;
  const moneyAgrees = refund.amountMinor !== null && found.money.amountMinor === refund.amountMinor && found.money.currency === refund.currency;
  return [
    {
      field: "refund_state",
      ledger: named,
      paypal: `${shown(found.status)} ${shown(found.id)}${others > 0 ? `, and ${others} other refund(s) on the order` : ""}`,
      result: verdict(stateAgrees),
    },
    {
      field: "refund_amount_minor",
      ledger: `${refund.amountMinor === null ? "(none)" : refund.amountMinor.toString()} ${refund.currency ?? ""}`.trim(),
      paypal: showMoney(found.money),
      result: verdict(moneyAgrees),
    },
  ];
}

/**
 * The whole verdict for one order. Pure: two records in, a list of fields out. No
 * model is called here or anywhere before the exit code is settled.
 *
 * Amounts are compared as bigint minor units. The amount is the capture's once
 * PayPal shows a paid capture, and the purchase unit's before that.
 */
export function compareOrder(ledger: LedgerOrder, paypal: PayPalOrder, lookup: RefundLookup): FieldCheck[] {
  const state = stateOf(paypal);
  const capture = paidCapture(paypal);
  const money = capture?.money ?? paypal.money;
  const captureCount = paypal.captures.length;
  const paypalCapture = capture !== null ? shown(capture.id) : captureCount === 0 ? "none" : `none paid (${captureCount} listed, ${shown(paypal.captures[0]?.status ?? null)})`;

  return [
    { field: "order_id", ledger: ledger.orderId, paypal: shown(paypal.id), result: verdict(paypal.id === ledger.orderId) },
    {
      field: "status",
      ledger: ledger.status,
      paypal: `${shown(paypal.status)}${captureCount > 0 ? `, capture ${shown(paypal.captures[0]?.status ?? null)}` : ""}`,
      result: verdict(AGREES[ledger.status].includes(state)),
    },
    {
      field: "amount_minor",
      ledger: ledger.amountMinor === null ? "(ledger rows disagree)" : ledger.amountMinor.toString(),
      paypal: paypal.unitCount !== 1 ? `(${paypal.unitCount} purchase units)` : money.amountMinor === null ? "(unreadable)" : money.amountMinor.toString(),
      result: verdict(ledger.amountMinor !== null && money.amountMinor === ledger.amountMinor),
    },
    { field: "currency", ledger: ledger.currency, paypal: shown(money.currencyCode), result: verdict(money.currency === ledger.currency) },
    {
      field: "capture_id",
      ledger: ledger.captureId ?? "none",
      paypal: paypalCapture,
      result: verdict(capture === null ? ledger.captureId === null && state !== "unsettled" && state !== "unknown" : capture.id !== null && capture.id === ledger.captureId),
    },
    ...refundChecks(ledger, paypal, lookup),
  ];
}
