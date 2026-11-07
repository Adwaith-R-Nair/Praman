import { minorToJSON, type Currency, type Minor, type Rail } from "@praman/shared";

export type { Rail } from "@praman/shared";

export interface ExecOutcome {
  readonly rail: Rail;
  readonly order_id: string;
  readonly status: "created" | "captured" | "failed";
  readonly amount_minor: Minor;
  /** What the rail said, not what it was asked for. acceptOutcome() compares the two. */
  readonly currency: Currency;
  readonly payment_id: string | null;
  /** Where a buyer goes to approve this order, on a rail that has a checkout. */
  readonly approve_url: string | null;
  readonly failure_code: string | null;
}

export interface CreateOrderRequest {
  readonly amount_minor: Minor;
  readonly currency: Currency;
  readonly idempotency_key: string;
  readonly receipt: string;
}

/** Everything a rail might need to find an order after a lost response. Each rail uses what it can (D-26). */
export interface OrderLookup {
  readonly receipt: string;
  readonly idempotency_key: string;
  readonly order_id: string | null;
  readonly amount_minor: Minor;
  readonly currency: Currency;
}

export interface CaptureRequest {
  readonly order_id: string;
  readonly amount_minor: Minor;
  readonly currency: Currency;
  readonly idempotency_key: string;
}

/** A throw from any of these means the outcome is unknown, so the caller leaves its record pending. */
export interface Executor {
  readonly rail: Rail;
  createOrder(req: CreateOrderRequest): Promise<ExecOutcome>;
  findOrder(lookup: OrderLookup): Promise<ExecOutcome | null>;
  capture(req: CaptureRequest): Promise<ExecOutcome>;
}

/** Null means this process can't pay on that rail. The caller denies. It never falls back to another rail. */
export type ExecutorRouter = (rail: Rail) => Executor | null;

/** Test and eval convenience: every merchant goes to this one executor, whatever its rail. */
export function routeAllTo(executor: Executor): ExecutorRouter {
  return () => executor;
}

/** The real router: a merchant's rail reaches the executor for that rail, or nothing. */
export function routeByRail(executors: readonly Executor[]): ExecutorRouter {
  return (rail) => executors.find((e) => e.rail === rail) ?? null;
}

/**
 * An order the rail says exists, but not the one Praman asked for. amount_minor
 * and currency are what T1 authorised, because that is the only money Praman can
 * vouch for. The rail_ fields keep what the rail said, for the human who has to
 * look at it. Never a success: nobody is sent to pay it. Never a failure either:
 * the order exists, so it holds budget (D-17, D-33).
 */
export interface MismatchedOutcome extends Omit<ExecOutcome, "status" | "failure_code"> {
  readonly status: "mismatch";
  readonly failure_code: "RAIL_CURRENCY_MISMATCH" | "RAIL_AMOUNT_MISMATCH";
  readonly rail_status: "created" | "captured";
  readonly rail_amount_minor: Minor;
  readonly rail_currency: Currency;
}

export type AcceptedOutcome = ExecOutcome | MismatchedOutcome;

/**
 * The rail's answer only counts if it is about the money Praman asked for. 1250
 * minor units of USD and 1250 of INR are not the same money, and a rail can answer
 * with success about an older order for another amount (D-26). A failure is passed
 * through: it says no order exists, so what it reports about money doesn't matter.
 */
export function acceptOutcome(outcome: ExecOutcome, requested: { readonly amount_minor: Minor; readonly currency: Currency }): AcceptedOutcome {
  if (outcome.status === "failed") return outcome;
  const currencyDiffers = outcome.currency !== requested.currency;
  if (!currencyDiffers && outcome.amount_minor === requested.amount_minor) return outcome;
  return {
    ...outcome,
    status: "mismatch",
    amount_minor: requested.amount_minor,
    currency: requested.currency,
    approve_url: null,
    failure_code: currencyDiffers ? "RAIL_CURRENCY_MISMATCH" : "RAIL_AMOUNT_MISMATCH",
    rail_status: outcome.status,
    rail_amount_minor: outcome.amount_minor,
    rail_currency: outcome.currency,
  };
}

/** The ledger fields for an outcome. One place, so T2 and the reconciler can't record an order differently. */
export function outcomeFields(outcome: AcceptedOutcome) {
  return {
    rail: outcome.rail,
    status: outcome.status,
    order_id: outcome.order_id,
    payment_id: outcome.payment_id,
    failure_code: outcome.failure_code,
    amount_minor: minorToJSON(outcome.amount_minor),
    currency: outcome.currency,
    ...(outcome.status === "mismatch"
      ? { rail_status: outcome.rail_status, rail_amount_minor: minorToJSON(outcome.rail_amount_minor), rail_currency: outcome.rail_currency }
      : {}),
  };
}

/**
 * What a rail's verified webhook says happened to a capture, reduced to the fields
 * Praman acts on. Every string has been checked against a narrow pattern by the rail
 * package, and the provider's free text (summaries, notes, custom ids) is dropped
 * there, so none of it reaches the ledger, a page or a prompt (invariant 7).
 */
export interface SettlementEvent {
  readonly rail: Rail;
  /** The provider's event id. Deliveries of one event share it, so it is what dedupes. */
  readonly event_id: string;
  readonly event_type: string;
  readonly status: "captured" | "declined";
  readonly order_id: string;
  readonly payment_id: string;
  readonly amount_minor: Minor;
  readonly currency: Currency;
  /** The invoice id the provider echoes back. Praman sets it to the order's receipt. */
  readonly invoice_id: string | null;
}
