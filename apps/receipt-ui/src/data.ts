import { prisma } from "@praman/db";
import { read, type LedgerEntryRecord } from "@praman/ledger";
import type { ConversationItem } from "@praman/agent-core";

export interface MerchantItemRead {
  readonly sku: string;
  readonly category: string;
  readonly pricePaise: string;
  readonly inStock: boolean;
  readonly title: string;
  readonly description: string;
}

export interface TraceView {
  readonly traceId: string;
  readonly entries: readonly LedgerEntryRecord[];
  readonly decisionKind: string | null;
  readonly reasonCode: string | null;
  /** Set instead of reasonCode when the final state isn't a formal ReasonCode — an approval rejected or left to expire. */
  readonly refusalReason: string | null;
  readonly amountPaise: string | null;
  readonly goal: string | null;
  readonly merchantId: string | null;
  readonly rationale: string | null;
  readonly merchantReads: readonly MerchantItemRead[];
  readonly orderId: string | null;
  readonly orderStatus: string | null;
  readonly approvalVerdict: string | null;
}

/**
 * Parses runTool()'s list_catalog/get_sku output (apps/buyer-agent/src/agent.ts)
 * back into one card per item, instead of showing the raw joined string as
 * one undifferentiated block. This is coupled to that function's exact
 * format by necessity — there's no structured version of "what the agent
 * read" to parse instead, only the text it was actually shown.
 */
function parseMerchantReads(raw: readonly string[]): MerchantItemRead[] {
  const pattern =
    /sku=(\S+)\s+category=(\S+)\s+price_paise=(\S+)\s+in_stock=(\S+)\s*\n<untrusted_merchant_content>\n([\s\S]*?)\n<\/untrusted_merchant_content>/g;
  const seen = new Set<string>();
  const items: MerchantItemRead[] = [];

  for (const block of raw) {
    for (const m of block.matchAll(pattern)) {
      const [, sku, category, pricePaise, inStock, titleAndDesc] = m;
      if (!sku || seen.has(sku)) continue;
      seen.add(sku);
      const newlineIdx = (titleAndDesc ?? "").indexOf("\n");
      const title = newlineIdx === -1 ? (titleAndDesc ?? "") : (titleAndDesc ?? "").slice(0, newlineIdx);
      const description = newlineIdx === -1 ? "" : (titleAndDesc ?? "").slice(newlineIdx + 1);
      items.push({
        sku,
        category: category ?? "",
        pricePaise: pricePaise ?? "0",
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

export async function loadTrace(traceId: string): Promise<TraceView | null> {
  const entries = await prisma.$transaction((tx) => read(tx, traceId));
  if (entries.length === 0) return null;

  const intent = firstPayload(entries, "intent");
  const decision = firstPayload(entries, "decision");
  const outcome = firstPayload(entries, "outcome");
  const stepUpResolved = firstPayload(entries, "step_up_resolved");
  const transcriptPayload = firstPayload(entries, "agent_transcript");

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

  if (outcome) {
    // Money was actually attempted — this supersedes any earlier STEP_UP.
    decisionKind = "ALLOW";
    reasonCode = "OK";
  } else if (stepUpResolved) {
    const verdict = asString(stepUpResolved["verdict"]);
    if (verdict === "reject") {
      decisionKind = "DENY";
      refusalReason =
        asString(stepUpResolved["reason"]) === "expired"
          ? "The approval window closed (15 minutes) before anyone acted on it."
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
    amountPaise: asString(outcome?.["amount_paise"]) ?? asString(decision?.["amount_paise"]),
    goal,
    merchantId: asString(intent?.["merchant_id"]),
    rationale: asString(intent?.["agent_rationale"]),
    merchantReads: parseMerchantReads(merchantReads),
    orderId: asString(outcome?.["order_id"]),
    orderStatus: asString(outcome?.["status"]),
    approvalVerdict: asString(stepUpResolved?.["verdict"]),
  };
}

/** Total number of real purchase traces ever recorded — not capped by listRecentTraceIds' limit. */
export async function countTraces(): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(DISTINCT trace_id)::bigint AS count FROM ledger_entry WHERE event_type = 'intent'
  `;
  return Number(rows[0]?.count ?? 0n);
}

/** The most recently active trace_ids, newest first — one row per trace, not per entry. */
export async function listRecentTraceIds(limit: number): Promise<readonly string[]> {
  // checkpoint entries carry a synthetic "ckpt_<seq>" trace_id (see
  // packages/ledger/src/checkpoint.ts) — a maintenance record, not a
  // purchase a human would want to click into. Every real trace starts
  // with an "intent" event; checkpoints never have one.
  const rows = await prisma.$queryRaw<{ trace_id: string }[]>`
    SELECT trace_id FROM ledger_entry
    WHERE trace_id IN (SELECT DISTINCT trace_id FROM ledger_entry WHERE event_type = 'intent')
    GROUP BY trace_id
    ORDER BY MAX(seq) DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => r.trace_id);
}
