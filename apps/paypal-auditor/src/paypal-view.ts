import { fromPayPalValue } from "@praman/paypal-exec";
import { isCurrency, type Currency, type Minor } from "@praman/shared";

/**
 * PayPal's JSON reduced to the facts the auditor compares. Every string kept has
 * matched a narrow pattern, so nothing PayPal wrote freely reaches the terminal, and
 * every amount went through fromPayPalValue: a decimal string to integer minor units,
 * with no float at any point (invariant 2).
 */
export interface PayPalMoney {
  /** Null when PayPal's value isn't a decimal string with two places. */
  readonly amountMinor: Minor | null;
  /** Null when it isn't a currency a mandate can name. */
  readonly currency: Currency | null;
  /** The three letters PayPal sent, for display. Null when they aren't three capitals. */
  readonly currencyCode: string | null;
}

export interface PayPalCapture {
  readonly id: string | null;
  readonly status: string | null;
  readonly money: PayPalMoney;
}

export interface PayPalRefund {
  readonly id: string | null;
  readonly status: string | null;
  readonly money: PayPalMoney;
  /** The capture its "up" link names. Null when there is no such link. */
  readonly captureId: string | null;
}

export interface PayPalOrder {
  readonly id: string | null;
  readonly status: string | null;
  /** The auditor reads an order with exactly one purchase unit, as the executor does. */
  readonly unitCount: number;
  readonly money: PayPalMoney;
  readonly captures: readonly PayPalCapture[];
  /** Refunds PayPal lists on the order. */
  readonly refunds: readonly PayPalRefund[];
}

export interface PayPalDispute {
  readonly id: string | null;
  readonly status: string | null;
  readonly reason: string | null;
  readonly stage: string | null;
  readonly money: PayPalMoney;
}

const TOKEN = /^[A-Za-z0-9_-]{1,64}$/;
const NO_MONEY: PayPalMoney = { amountMinor: null, currency: null, currencyCode: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function token(value: unknown): string | null {
  return typeof value === "string" && TOKEN.test(value) ? value : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function readMoney(amount: unknown): PayPalMoney {
  if (!isRecord(amount)) return NO_MONEY;
  const code = amount["currency_code"];
  let amountMinor: Minor | null = null;
  try {
    amountMinor = fromPayPalValue(amount["value"]);
  } catch {
    amountMinor = null;
  }
  return { amountMinor, currency: isCurrency(code) ? code : null, currencyCode: typeof code === "string" && /^[A-Z]{3}$/.test(code) ? code : null };
}

/** The capture id at the end of a refund's "up" link, read the way paypal-exec reads it. */
function upCapture(links: unknown): string | null {
  for (const link of records(links)) {
    if (link["rel"] !== "up" || typeof link["href"] !== "string") continue;
    try {
      return token(/\/v2\/payments\/captures\/([^/]+)$/.exec(new URL(link["href"]).pathname)?.[1]);
    } catch {
      return null;
    }
  }
  return null;
}

export function readRefund(body: Readonly<Record<string, unknown>>): PayPalRefund {
  return { id: token(body["id"]), status: token(body["status"]), money: readMoney(body["amount"]), captureId: upCapture(body["links"]) };
}

/** Shapes seen live on 2026-11-09 through the toolkit's get_order: a paid and refunded order, and two unpaid ones. */
export function readOrder(body: Readonly<Record<string, unknown>>): PayPalOrder {
  const units = records(body["purchase_units"]);
  const unit = units.length === 1 ? units[0] : undefined;
  const payments = unit !== undefined && isRecord(unit["payments"]) ? unit["payments"] : {};
  return {
    id: token(body["id"]),
    status: token(body["status"]),
    unitCount: units.length,
    money: unit === undefined ? NO_MONEY : readMoney(unit["amount"]),
    captures: records(payments["captures"]).map((capture) => ({ id: token(capture["id"]), status: token(capture["status"]), money: readMoney(capture["amount"]) })),
    refunds: records(payments["refunds"]).map(readRefund),
  };
}

/** The ids in a list_disputes answer. The answer's shape is PayPal's documented one: no dispute existed to read live. */
export function readDisputeIds(body: Readonly<Record<string, unknown>>): string[] {
  return records(body["items"]).flatMap((item) => token(item["dispute_id"]) ?? []);
}

export function readDispute(body: Readonly<Record<string, unknown>>): PayPalDispute {
  return {
    id: token(body["dispute_id"]),
    status: token(body["status"]),
    reason: token(body["reason"]),
    stage: token(body["dispute_life_cycle_stage"]),
    money: readMoney(body["dispute_amount"]),
  };
}
