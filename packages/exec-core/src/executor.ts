import type { Currency, Minor, Rail } from "@praman/shared";

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
 * The rail's answer only counts if it is about the currency Praman asked for.
 * 1250 minor units of USD and 1250 of INR are not the same money, and a rail
 * can answer with success about something else (D-26). Keeps what the rail
 * said, so the ledger records it, and marks it failed so it holds no budget.
 */
export function acceptOutcome(outcome: ExecOutcome, requested: Currency): ExecOutcome {
  if (outcome.currency === requested) return outcome;
  return { ...outcome, status: "failed", approve_url: null, failure_code: "RAIL_CURRENCY_MISMATCH" };
}
