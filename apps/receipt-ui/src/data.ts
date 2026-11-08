import { prisma } from "@praman/db";
import { amountIfPresent, read, readCurrency, type LedgerEntryRecord } from "@praman/ledger";
import { formatMoney, isCurrency, minorFromJSON, type Currency } from "@praman/shared";
import type { ConversationItem } from "@praman/agent-core";
import { DEMO_MERCHANTS } from "./demo/config.js";

export interface MerchantItemRead {
  readonly sku: string;
  readonly category: string;
  readonly priceMinor: string;
  readonly currency: Currency;
  readonly inStock: boolean;
  readonly title: string;
  readonly description: string;
}

/** The latest thing a payment provider reported by verified webhook about this trace's order (D-45). */
export interface SettlementLine {
  readonly rail: string | null;
  readonly status: string | null;
  readonly paymentId: string | null;
  readonly eventId: string | null;
  readonly at: Date;
}

export interface TraceView {
  readonly traceId: string;
  readonly entries: readonly LedgerEntryRecord[];
  readonly decisionKind: string | null;
  readonly reasonCode: string | null;
  /** Set instead of reasonCode when the final state isn't a formal ReasonCode — an approval rejected or left to expire. */
  readonly refusalReason: string | null;
  readonly amountMinor: string | null;
  readonly currency: Currency;
  readonly goal: string | null;
  readonly merchantId: string | null;
  readonly rationale: string | null;
  /** The model whose recorded answer was replayed for this cart, or null for a live model or none. */
  readonly recordedModel: string | null;
  readonly merchantReads: readonly MerchantItemRead[];
  readonly orderId: string | null;
  readonly orderStatus: string | null;
  /** The rail's own code when the latest outcome is a failure. Executor vocabulary, not a reason code (D-32). */
  readonly railFailureCode: string | null;
  readonly approvalVerdict: string | null;
  /**
   * Who resolved the step-up. "test_harness" when the intent came from the demo's
   * concurrency harness (model id "harness/..."), which approves its own first
   * purchase in code (apps/receipt-ui/src/demo/story.ts). Anything else is a person,
   * through the demo page or `pnpm approve`.
   */
  readonly approvedBy: "person" | "test_harness" | null;
  /**
   * How the money moved, when the ledger shows it. "saved_method": the order's first
   * outcome is a PayPal capture, which only a charge to a saved payment method gives,
   * since a checkout order is created first and captured later (D-49, D-50). There was
   * no buyer at PayPal. "checkout": created, then captured after the buyer approved.
   */
  readonly payment: "saved_method" | "checkout" | null;
  readonly settlement: SettlementLine | null;
  /** Non-evidentiary pointer to this run's Langfuse trace, if tracing was configured when it ran. See D-47. */
  readonly langfuseTraceId: string | null;
  /** Set when this trace withdraws a mandate: its own trace, with one mandate_revoked row and no purchase. */
  readonly revocation: { readonly mandateId: string | null; readonly reason: string | null } | null;
}

/**
 * Parses runTool()'s list_catalog/get_sku output (apps/buyer-agent/src/agent.ts)
 * back into one card per item, instead of showing the raw joined string as
 * one undifferentiated block. This is coupled to that function's exact
 * format by necessity — there's no structured version of "what the agent
 * read" to parse instead, only the text it was actually shown. Transcripts
 * recorded before the rename to minor units say price_paise, and they sit in
 * the ledger for good, so both names match. They also show no currency, and they
 * are INR, because nothing else existed then.
 */
function parseMerchantReads(raw: readonly string[]): MerchantItemRead[] {
  const pattern =
    /sku=(\S+)\s+category=(\S+)\s+price_(?:paise|minor)=(\S+)(?:\s+currency=(\S+))?\s+in_stock=(\S+)\s*\n<untrusted_merchant_content>\n([\s\S]*?)\n<\/untrusted_merchant_content>/g;
  const seen = new Set<string>();
  const items: MerchantItemRead[] = [];

  for (const block of raw) {
    for (const m of block.matchAll(pattern)) {
      const [, sku, category, priceMinor, currency, inStock, titleAndDesc] = m;
      if (!sku || seen.has(sku)) continue;
      const itemCurrency = currency ?? "INR";
      if (!isCurrency(itemCurrency)) continue;
      seen.add(sku);
      const newlineIdx = (titleAndDesc ?? "").indexOf("\n");
      const title = newlineIdx === -1 ? (titleAndDesc ?? "") : (titleAndDesc ?? "").slice(0, newlineIdx);
      const description = newlineIdx === -1 ? "" : (titleAndDesc ?? "").slice(newlineIdx + 1);
      items.push({
        sku,
        category: category ?? "",
        priceMinor: priceMinor ?? "0",
        currency: itemCurrency,
        inStock: inStock === "true",
        title,
        description,
      });
    }
  }
  return items;
}

function firstPayload(entries: readonly LedgerEntryRecord[], eventType: string): Record<string, unknown> | null {
  const e = entries.find((x) => x.eventType === eventType);
  return e ? (e.payload as Record<string, unknown>) : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * An order can have several outcome rows: created, then captured, failed at capture
 * or released (D-30, D-40). The first is the order and its amount, the last is where
 * it stands. A trace with one outcome, which is every trace before checkouts, reads
 * the same either way.
 */
function outcomeEnds(entries: readonly LedgerEntryRecord[]): { first: Record<string, unknown> | null; last: Record<string, unknown> | null; lastSeq: bigint | null } {
  const outcomes = entries.filter((e) => e.eventType === "outcome");
  const first = outcomes[0];
  const last = outcomes.at(-1);
  return {
    first: first ? (first.payload as Record<string, unknown>) : null,
    last: last ? (last.payload as Record<string, unknown>) : null,
    lastSeq: last ? last.seq : null,
  };
}

/**
 * The capture refusal that stands, if any: a DENY at capture with no outcome after it.
 * Only a mandate's proven holder counts. A claim with a bad signature is on the trace
 * as evidence, and changes nothing about the order (D-25).
 */
function standingCaptureRefusal(entries: readonly LedgerEntryRecord[], lastOutcomeSeq: bigint | null): Record<string, unknown> | null {
  const decisions = entries.filter((e) => e.eventType === "capture_decision" && typeof (e.payload as Record<string, unknown>)["mandate_id"] === "string");
  const last = decisions.at(-1);
  if (!last || (lastOutcomeSeq !== null && last.seq < lastOutcomeSeq)) return null;
  const payload = last.payload as Record<string, unknown>;
  return payload["kind"] === "DENY" ? payload : null;
}

/** Intents the test harness made, with no model, carry a model id with this prefix. */
export const HARNESS_MODEL_PREFIX = "harness/";
/** A model id with this prefix means the cart came from a recorded model answer, replayed (apps/receipt-ui/src/demo/recorded-model.ts). */
export const RECORDED_MODEL_PREFIX = "recorded/";

/** What a rail said in a mismatch, in words: its amount and status, when they are on the row. */
function railReported(outcome: Record<string, unknown>): string {
  const status = asString(outcome["rail_status"]);
  const amount = asString(outcome["rail_amount_minor"]);
  const currency = asString(outcome["rail_currency"]);
  const money = amount !== null && /^\d+$/.test(amount) && currency !== null && isCurrency(currency) ? formatMoney(minorFromJSON(amount), currency) : null;
  if (money === null && status === null) return "";
  return `: it reported ${[money, status === null ? null : `status ${status}`].filter((x) => x !== null).join(", ")}`;
}

function paymentOf(first: Record<string, unknown> | null, last: Record<string, unknown> | null): TraceView["payment"] {
  if (first === null || last === null || asString(first["rail"]) !== "paypal") return null;
  const firstStatus = asString(first["status"]);
  if (firstStatus === "captured" && !("capture_key" in first)) return "saved_method";
  if (firstStatus === "created" && asString(last["status"]) === "captured") return "checkout";
  return null;
}

function recordedModelOf(modelId: string | null): string | null {
  return modelId !== null && modelId.startsWith(RECORDED_MODEL_PREFIX) ? modelId.slice(RECORDED_MODEL_PREFIX.length) : null;
}

export async function loadTrace(traceId: string): Promise<TraceView | null> {
  const entries = await prisma.$transaction((tx) => read(tx, traceId));
  if (entries.length === 0) return null;

  const intent = firstPayload(entries, "intent");
  const decision = firstPayload(entries, "decision");
  const { first: outcome, last: latestOutcome, lastSeq } = outcomeEnds(entries);
  const captureRefusal = standingCaptureRefusal(entries, lastSeq);
  const stepUpResolved = firstPayload(entries, "step_up_resolved");
  const transcriptPayload = firstPayload(entries, "agent_transcript");
  const settlementRow = entries.filter((e) => e.eventType === "settlement").at(-1);
  const settlementPayload = settlementRow ? (settlementRow.payload as Record<string, unknown>) : null;

  const byHarness = (asString(intent?.["model_id"]) ?? "").startsWith(HARNESS_MODEL_PREFIX);
  const revoked = firstPayload(entries, "mandate_revoked");

  let goal: string | null = null;
  const merchantReads: string[] = [];
  if (transcriptPayload) {
    const transcript = transcriptPayload["transcript"] as ConversationItem[] | undefined;
    for (const item of transcript ?? []) {
      if (item.role === "user") {
        const match = /Goal:\s*(.+)/s.exec(item.text);
        if (match?.[1]) goal = match[1].trim();
      }
      if (item.role === "tool_results") {
        for (const r of item.results) merchantReads.push(r.content);
      }
    }
  }

  // The "decision" event only ever records the ORIGINAL call — a STEP_UP
  // that was later approved and executed never gets a second "decision"
  // event, only step_up_resolved + api_call + outcome. Showing the original
  // STEP_UP forever would misrepresent a trace that actually executed. The
  // final state has to be read off whichever of these actually happened
  // last, not just the first "decision" event found.
  let decisionKind = asString(decision?.["kind"]);
  let reasonCode = asString(decision?.["reason_code"]);
  let refusalReason: string | null = null;

  const railFailed = latestOutcome !== null && asString(latestOutcome["status"]) === "failed";
  const railMismatch = latestOutcome !== null && asString(latestOutcome["status"]) === "mismatch";
  if (outcome && captureRefusal) {
    // A capture Praman refused after the order existed: its own reason stands (D-31).
    decisionKind = "DENY";
    reasonCode = asString(captureRefusal["reason_code"]);
  } else if (outcome && railFailed) {
    // Praman allowed it and the rail said no. That is not "Allowed" and not OK: no money
    // moved. A failed capture leaves the order and its hold in place (D-40); a failed
    // create means no order exists. The rail's code is shown, not turned into a reason code.
    const atCapture = outcome !== latestOutcome || "capture_key" in latestOutcome;
    decisionKind = atCapture ? "CAPTURE_FAILED" : "ORDER_FAILED";
    reasonCode = null;
    refusalReason = atCapture
      ? "Praman allowed the capture, and the payment provider refused it. No money moved. The order still holds its budget, and it can be captured again until it is released."
      : "Praman allowed this purchase, and the payment provider refused to create the order. No money moved, and nothing is held.";
  } else if (outcome && railMismatch) {
    // The rail answered about other money than Praman asked for (D-33). That is a
    // failure for a person to look at, not "Allowed". The order holds its budget.
    decisionKind = "RAIL_MISMATCH";
    reasonCode = null;
    refusalReason = `Praman allowed this purchase, and the payment provider answered about different money than Praman asked for${railReported(latestOutcome)}. The order still holds its budget and needs a person to look. Praman did not retry.`;
  } else if (outcome) {
    // Money was actually attempted — this supersedes any earlier STEP_UP.
    decisionKind = "ALLOW";
    reasonCode = "OK";
  } else if (intent === null && revoked !== null) {
    // Not a purchase at all: the issuer took a mandate's authority back.
    decisionKind = "REVOKED";
  } else if (stepUpResolved) {
    const verdict = asString(stepUpResolved["verdict"]);
    if (verdict === "reject") {
      decisionKind = "DENY";
      refusalReason =
        asString(stepUpResolved["reason"]) === "expired"
          ? "The approval window closed (15 minutes) before anyone acted on it."
          : byHarness
            ? "The test harness rejected this purchase."
            : "The human reviewer rejected this purchase.";
    } else if (verdict === "approve" && asString(stepUpResolved["revalidated_kind"]) === "DENY") {
      // Approved, but re-evaluation at resolution time refused it anyway
      // (expired/revoked/repriced since the step-up — D-24).
      decisionKind = "DENY";
      reasonCode = asString(stepUpResolved["revalidated_reason"]);
    }
  }

  return {
    traceId,
    entries,
    decisionKind,
    reasonCode,
    refusalReason,
    amountMinor: (outcome && amountIfPresent(outcome)) ?? (decision && amountIfPresent(decision)),
    currency: readCurrency(outcome ?? decision ?? {}),
    goal,
    merchantId: asString(intent?.["merchant_id"]),
    rationale: asString(intent?.["agent_rationale"]),
    recordedModel: recordedModelOf(asString(intent?.["model_id"])),
    merchantReads: parseMerchantReads(merchantReads),
    orderId: asString(latestOutcome?.["order_id"]) ?? asString(outcome?.["order_id"]),
    orderStatus: asString(latestOutcome?.["status"]),
    railFailureCode: railFailed ? asString(latestOutcome["failure_code"]) : null,
    approvalVerdict: asString(stepUpResolved?.["verdict"]),
    payment: paymentOf(outcome, latestOutcome),
    approvedBy: stepUpResolved === null ? null : byHarness ? "test_harness" : "person",
    settlement:
      settlementRow && settlementPayload
        ? {
            rail: asString(settlementPayload["rail"]),
            status: asString(settlementPayload["status"]),
            paymentId: asString(settlementPayload["payment_id"]),
            eventId: asString(settlementPayload["event_id"]),
            at: settlementRow.ts,
          }
        : null,
    langfuseTraceId: asString((transcriptPayload?.["observability"] as Record<string, unknown> | undefined)?.["langfuse_trace_id"]),
    revocation: revoked === null ? null : { mandateId: asString(revoked["mandate_id"]), reason: asString(revoked["reason"]) },
  };
}

/** Total number of real purchase traces ever recorded, demo visitors' left out — not capped by listRecentTraceIds' limit. */
export async function countTraces(): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(DISTINCT trace_id)::bigint AS count FROM ledger_entry
    WHERE event_type = 'intent' AND COALESCE(payload->>'merchant_id', '') <> ALL(${DEMO_MERCHANTS})
  `;
  return Number(rows[0]?.count ?? 0n);
}

/**
 * The most recently active trace_ids, newest first — one row per trace, not per entry.
 * Demo visitors' traces are left out: each visitor reaches their own from the demo page,
 * and a public list of everyone's would show one visitor another's purchases.
 */
export async function listRecentTraceIds(limit: number): Promise<readonly string[]> {
  // checkpoint entries carry a synthetic "ckpt_<seq>" trace_id (see
  // packages/ledger/src/checkpoint.ts) — a maintenance record, not a
  // purchase a human would want to click into. Every real trace starts
  // with an "intent" event; checkpoints never have one.
  const rows = await prisma.$queryRaw<{ trace_id: string }[]>`
    SELECT trace_id FROM ledger_entry
    WHERE trace_id IN (
      SELECT DISTINCT trace_id FROM ledger_entry
      WHERE event_type = 'intent' AND COALESCE(payload->>'merchant_id', '') <> ALL(${DEMO_MERCHANTS})
    )
    GROUP BY trace_id
    ORDER BY MAX(seq) DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => r.trace_id);
}
