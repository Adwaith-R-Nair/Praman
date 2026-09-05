import { prisma } from "@praman/db";
import { read, type LedgerEntryRecord } from "@praman/ledger";
import type { ConversationItem } from "@praman/agent-core";

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
  readonly merchantReads: readonly string[];
  readonly orderId: string | null;
  readonly orderStatus: string | null;
  readonly approvalVerdict: string | null;
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
    merchantReads,
    orderId: asString(outcome?.["order_id"]),
    orderStatus: asString(outcome?.["status"]),
    approvalVerdict: asString(stepUpResolved?.["verdict"]),
  };
}
