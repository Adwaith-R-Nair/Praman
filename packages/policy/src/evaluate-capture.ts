import type { Currency, DenyCode, LedgerDerivedState, Minor } from "@praman/shared";
import type { VerifiedMandate } from "./types.js";

export interface CaptureInput {
  readonly mandate: VerifiedMandate;
  readonly state: LedgerDerivedState;
  readonly now: Date;
  readonly order: {
    readonly idempotency_key: string;
    readonly held_amount_minor: Minor;   // from the ledger
    readonly quoted_amount_minor: Minor; // from the rail
    readonly currency: Currency;
  };
}

export type CaptureDecision =
  | { readonly kind: "ALLOW_CAPTURE"; readonly amount_minor: Minor; readonly reason_code: "OK" }
  | { readonly kind: "DENY"; readonly reason_code: DenyCode; readonly detail: string };

/**
 * On a rail with a buyer checkout, time passes between creating an order and
 * capturing it, and the mandate can stop being good in between. This decides
 * whether the capture may still go ahead (D-31).
 *
 * It is not evaluate() run again. That would return DUPLICATE_INTENT, since the
 * order's key is already spent. Limits, scope and velocity aren't checked either:
 * those were decided when the order was created, and the hold already counts.
 * Only what can change during a checkout is checked here.
 */
export function evaluateCapture(input: CaptureInput): CaptureDecision {
  const { mandate, state, now, order } = input;
  const ts = now.getTime();

  // 1. Released — first, because it is final. Whatever else is true, this
  //    order can never be captured, and its budget has already gone back.
  if (state.released_keys.has(order.idempotency_key)) {
    return {
      kind: "DENY",
      reason_code: "ORDER_RELEASED",
      detail: `Order ${order.idempotency_key} was not approved in time and its hold has been released.`,
    };
  }

  // 2. Revocation.
  if (state.revoked) {
    return {
      kind: "DENY",
      reason_code: "MANDATE_REVOKED",
      detail: "This mandate has been revoked by the issuer.",
    };
  }

  // 3. Validity window, with the same boundaries as evaluate().
  if (ts < mandate.validity.not_before.getTime()) {
    return {
      kind: "DENY",
      reason_code: "MANDATE_NOT_YET_VALID",
      detail: `Mandate is not yet valid. Valid from ${mandate.validity.not_before.toISOString()}.`,
    };
  }
  if (ts > mandate.validity.not_after.getTime()) {
    return {
      kind: "DENY",
      reason_code: "MANDATE_EXPIRED",
      detail: `Mandate expired at ${mandate.validity.not_after.toISOString()}.`,
    };
  }

  // 4. Currency — before the amounts, because two amounts in different
  //    currencies can't be compared, even if the numbers are equal.
  if (order.currency !== mandate.scope.currency) {
    return {
      kind: "DENY",
      reason_code: "CURRENCY_MISMATCH",
      detail: `Order is in ${order.currency}; this mandate is in ${mandate.scope.currency}.`,
    };
  }

  // 5. The rail must be asking for exactly what the ledger is holding.
  if (order.quoted_amount_minor !== order.held_amount_minor) {
    return {
      kind: "DENY",
      reason_code: "AMOUNT_CHANGED_SINCE_APPROVAL",
      detail: `Rail quotes ${order.quoted_amount_minor.toString()} minor units; the ledger holds ${order.held_amount_minor.toString()}.`,
    };
  }

  // 6. All clear. The amount comes from the ledger, never from the rail.
  return { kind: "ALLOW_CAPTURE", amount_minor: order.held_amount_minor, reason_code: "OK" };
}
