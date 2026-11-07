import { prisma, type PrismaTx } from "@praman/db";
import { read, type LedgerEntryRecord } from "@praman/ledger";
import { APPROVAL_TTL_MS, orderProgress, parseCachedOutcome } from "@praman/control-plane";
import { formatMoney, isCurrency, minorFromDb, minorFromJSON, type Currency, type DenyCode, type Minor } from "@praman/shared";
import { DENY_PLAIN } from "./plain.js";

/**
 * Every answer the gateway gives about a purchase. Only EXECUTED means Praman
 * authorised it and an order exists at the rail. APPROVAL_REQUIRED is never
 * success: nothing has been ordered.
 */
export type PurchaseStatus = "EXECUTED" | "APPROVAL_REQUIRED" | "DENIED" | "REJECTED" | "PENDING" | "FAILED" | "RELEASED";

export interface Links {
  readonly receipt_url: string;
  readonly dispute_url: string;
}

export interface PurchaseResult {
  readonly status: PurchaseStatus;
  readonly trace_id: string;
  /** Plain words: what happened, and what the agent or the person does next. */
  readonly message: string;
  readonly merchant_id?: string;
  readonly items?: readonly { readonly sku: string; readonly qty: number }[];
  readonly amount_minor?: string;
  readonly currency?: Currency;
  readonly amount?: string;
  readonly reason_code?: DenyCode;
  readonly approval?: { readonly approval_id: string; readonly approve_command: string; readonly reject_command: string; readonly expires_at: string };
  readonly receipt?: {
    readonly rail: string;
    readonly order_id: string;
    /** "captured": money moved. "awaiting_buyer": the buyer still has to pay at PayPal. */
    readonly payment: "captured" | "awaiting_buyer";
    readonly pay_url?: string;
  };
  readonly links: Links;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function field(e: LedgerEntryRecord | undefined, name: string): unknown {
  return e !== undefined && isRecord(e.payload) ? e.payload[name] : undefined;
}

function isDenyCode(v: unknown): v is DenyCode {
  return typeof v === "string" && Object.hasOwn(DENY_PLAIN, v);
}

function asDenyCode(v: unknown): DenyCode | null {
  return isDenyCode(v) ? v : null;
}

export function linksFor(baseUrl: string, traceId: string): Links {
  const id = encodeURIComponent(traceId);
  return { receipt_url: `${baseUrl}/r/${id}`, dispute_url: `${baseUrl}/dispute/${id}` };
}

export function approveCommands(approvalId: string): { approve_command: string; reject_command: string } {
  return { approve_command: `pnpm mcp:approve ${approvalId} approve`, reject_command: `pnpm mcp:approve ${approvalId} reject` };
}

function denied(base: Base, code: DenyCode | null, fallback: string): PurchaseResult {
  if (code === null) return { ...base, status: "DENIED", message: fallback };
  return { ...base, status: "DENIED", reason_code: code, message: DENY_PLAIN[code] };
}

type Base = Pick<PurchaseResult, "trace_id" | "links"> & Partial<Pick<PurchaseResult, "merchant_id" | "items" | "amount_minor" | "currency" | "amount">>;

function money(amount: Minor, currency: Currency): Pick<PurchaseResult, "amount_minor" | "currency" | "amount"> {
  return { amount_minor: amount.toString(), currency, amount: formatMoney(amount, currency) };
}

/**
 * Where one purchase stands, read from the ledger, the outbox record and the
 * approval, the same sources the trace page reads. Null when the trace doesn't
 * exist or its intent was made under another mandate: this gateway only talks
 * about its own mandate's purchases.
 */
export async function readPurchase(traceId: string, mandateId: string, baseUrl: string, now: Date, db: typeof prisma = prisma): Promise<PurchaseResult | null> {
  return db.$transaction((tx) => readPurchaseTx(tx, traceId, mandateId, baseUrl, now));
}

async function readPurchaseTx(tx: PrismaTx, traceId: string, mandateId: string, baseUrl: string, now: Date): Promise<PurchaseResult | null> {
  const entries = await read(tx, traceId);
  const intent = entries.find((e) => e.eventType === "intent" && field(e, "mandate_id") === mandateId);
  if (intent === undefined) return null;

  const lineItems = field(intent, "line_items");
  const items = Array.isArray(lineItems)
    ? lineItems.flatMap((li: unknown) => (isRecord(li) && typeof li["sku"] === "string" && typeof li["qty"] === "number" ? [{ sku: li["sku"], qty: li["qty"] }] : []))
    : [];
  const merchant = field(intent, "merchant_id");
  let base: Base = { trace_id: traceId, links: linksFor(baseUrl, traceId), ...(typeof merchant === "string" ? { merchant_id: merchant } : {}), items };

  const decision = entries.find((e) => e.eventType === "decision" && field(e, "mandate_id") === mandateId);
  const decidedAmount = field(decision, "amount_minor");
  const decidedCurrency = field(decision, "currency");
  if (typeof decidedAmount === "string" && /^\d+$/.test(decidedAmount) && isCurrency(decidedCurrency)) {
    base = { ...base, ...money(minorFromJSON(decidedAmount), decidedCurrency) };
  }

  // ── An order exists, or was attempted ──
  const record = await tx.idempotencyRecord.findFirst({ where: { traceId, kind: "order" }, orderBy: { createdAt: "desc" } });
  if (record !== null) {
    if (record.amountMinor !== null && isCurrency(record.currency)) base = { ...base, ...money(minorFromDb(record.amountMinor), record.currency) };
    if (record.status === "pending") {
      return { ...base, status: "PENDING", message: "Praman called the rail and hasn't heard back yet. Nothing is retried on its own; pnpm reconcile settles it. Check again with get_receipt." };
    }
    const cached = parseCachedOutcome(record, record.key);
    if (record.status === "failed" || cached.orderId === null) {
      return { ...base, status: "FAILED", message: "The payment rail did not take this order. No money moved and no budget is held." };
    }
    if (cached.status === "mismatch") {
      return { ...base, status: "FAILED", message: "The rail answered with a different amount or currency than Praman authorised. The order is held against the budget until a person checks the trace." };
    }
    const progress = await orderProgress(tx, record.key, cached.orderId);
    if (progress === "released") return { ...base, status: "RELEASED", message: DENY_PLAIN.ORDER_RELEASED };

    // A capture Praman refused on a re-check is the answer that stands (D-31).
    const lastOutcome = entries.findLast((e) => e.eventType === "outcome");
    const lastCaptureDecision = entries.findLast((e) => e.eventType === "capture_decision" && field(e, "mandate_id") === mandateId);
    const captured = progress === "captured" || cached.status === "captured";
    if (!captured && lastCaptureDecision !== undefined && field(lastCaptureDecision, "kind") === "DENY" && (lastOutcome === undefined || lastCaptureDecision.seq > lastOutcome.seq)) {
      return denied(base, asDenyCode(field(lastCaptureDecision, "reason_code")), "Praman refused the capture on a re-check of the mandate.");
    }

    const payUrl = !captured && cached.approveUrl !== null ? cached.approveUrl : null;
    return {
      ...base,
      status: "EXECUTED",
      message: captured
        ? "Paid. Praman authorised this purchase within the mandate and the rail captured the payment."
        : "Praman authorised this purchase and created the order at PayPal. The buyer pays at pay_url (the PayPal sandbox login), then call complete_checkout with this trace_id. Nothing is charged before that.",
      receipt: { rail: record.rail, order_id: cached.orderId, payment: captured ? "captured" : "awaiting_buyer", ...(payUrl !== null ? { pay_url: payUrl } : {}) },
    };
  }

  // ── A person's approval was asked for ──
  const approval = await tx.approval.findFirst({ where: { traceId, mandateId } });
  if (approval !== null) {
    const resolved = entries.findLast((e) => e.eventType === "step_up_resolved");
    if (approval.status === "pending") {
      const expiresAt = new Date(approval.createdAt.getTime() + APPROVAL_TTL_MS);
      if (now.getTime() > expiresAt.getTime()) return { ...base, status: "REJECTED", message: "Nobody approved this within 15 minutes, so the approval expired. Nothing was bought." };
      return {
        ...base,
        status: "APPROVAL_REQUIRED",
        message:
          "Not bought yet. Praman needs a person to approve this purchase. Ask the person to run approve_command in a terminal in the Praman repo, then call check_approval. Don't run it yourself.",
        approval: { approval_id: approval.approvalId, ...approveCommands(approval.approvalId), expires_at: expiresAt.toISOString() },
      };
    }
    if (field(resolved, "verdict") === "approve" && field(resolved, "revalidated_kind") === "DENY") {
      return denied(base, asDenyCode(field(resolved, "revalidated_reason")), "The person approved it, but a fresh check of the mandate refused it.");
    }
    const reason = field(resolved, "reason");
    return { ...base, status: "REJECTED", message: reason === "expired" ? "Nobody approved this within 15 minutes, so the approval expired. Nothing was bought." : "The person rejected this purchase. Nothing was bought. Don't propose it again unless they ask." };
  }

  // ── Decided with no order and no approval: a refusal ──
  if (field(decision, "kind") === "DENY") return denied(base, asDenyCode(field(decision, "reason_code")), "Praman refused this purchase.");
  return { ...base, status: "PENDING", message: "Praman has a record of this purchase but no outcome yet. Check again with get_receipt." };
}

/** The ledger events of a trace, without payloads: payloads carry merchant text and the agent's reads. */
export async function traceEvents(traceId: string, db: typeof prisma = prisma): Promise<readonly { seq: string; ts: string; actor: string; event_type: string }[]> {
  const entries = await db.$transaction((tx) => read(tx, traceId));
  return entries.map((e) => ({ seq: e.seq.toString(), ts: e.ts.toISOString(), actor: e.actor, event_type: e.eventType }));
}
