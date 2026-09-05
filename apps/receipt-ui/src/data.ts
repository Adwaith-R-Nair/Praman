import { prisma } from "@praman/db";
import { read, type LedgerEntryRecord } from "@praman/ledger";
import type { ConversationItem } from "@praman/agent-core";

export interface TraceView {
  readonly traceId: string;
  readonly entries: readonly LedgerEntryRecord[];
  readonly decisionKind: string | null;
  readonly reasonCode: string | null;
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

  return {
    traceId,
    entries,
    decisionKind: asString(decision?.["kind"]),
    reasonCode: asString(decision?.["reason_code"]) ?? asString(stepUpResolved?.["revalidated_reason"]),
    amountPaise: asString(decision?.["amount_paise"]),
    goal,
    merchantId: asString(intent?.["merchant_id"]),
    rationale: asString(intent?.["agent_rationale"]),
    merchantReads,
    orderId: asString(outcome?.["order_id"]),
    orderStatus: asString(outcome?.["status"]),
    approvalVerdict: asString(stepUpResolved?.["verdict"]),
  };
}
