import { prisma, type PrismaTx } from "@praman/db";
import { read, verifyChain, type LedgerEntryRecord } from "@praman/ledger";

export interface DisputeBundle {
  readonly trace_id: string;
  readonly generated_at: string;
  readonly mandate: {
    readonly id: string;
    /**
     * Not durably recorded anywhere — the ledger's intent/decision events
     * only ever store mandate_id (packages/control-plane/src/run-intent.ts),
     * never issuer_id, and the `mandate` DB table (packages/db's own
     * schema) has a column for it but no code path writes to that table at
     * all. Left null rather than fabricated; a future improvement is
     * recording issuer_id on the intent event itself.
     */
    readonly issuer: null;
    /**
     * Derived from the ledger, not asserted: true unless this trace's own
     * decision was denied specifically for MANDATE_SIGNATURE_INVALID — the
     * only way any other outcome (ALLOW/STEP_UP/other DENY reasons) could
     * exist on this trace is if verifyMandate() already passed at the time.
     */
    readonly signature_verified: boolean;
  };
  readonly authorisation: {
    readonly decision: string | null;
    readonly reason_code: string | null;
    readonly amount_paise: string | null;
    readonly evaluated_at: string | null;
  };
  readonly agent: {
    readonly model_id: string | null;
    readonly goal: string | null;
    readonly rationale: string | null;
    readonly tool_calls: readonly { readonly name: string; readonly input: unknown; readonly result: string | null }[];
  };
  readonly merchant_content_read: readonly { readonly sku: string; readonly text: string; readonly marked_untrusted: true }[];
  readonly execution: {
    readonly order_id: string | null;
    readonly status: string | null;
    readonly idempotency_key: string | null;
  } | null;
  readonly chain: {
    readonly entries: readonly {
      readonly seq: string;
      readonly ts: string;
      readonly actor: string;
      readonly event_type: string;
      readonly payload: unknown;
      readonly payload_hash: string;
      readonly prev_hash: string;
      readonly entry_hash: string;
    }[];
    /** The full ledger's own integrity as of build time — recomputed live, not cached. */
    readonly global_chain_ok: boolean;
    readonly checked_through_seq: string | null;
    readonly head: string | null;
    /** Whether every one of THIS trace's own entries falls inside the verified range. */
    readonly trace_fully_verified: boolean;
  };
}

function payloadOf(entries: readonly LedgerEntryRecord[], eventType: string): Record<string, unknown> | null {
  const e = entries.find((x) => x.eventType === eventType);
  return e ? (e.payload as Record<string, unknown>) : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * Same tool-output format runTool() (apps/buyer-agent/src/agent.ts)
 * produces, parsed back into per-SKU records — duplicated from
 * apps/receipt-ui/src/data.ts's parseMerchantReads() rather than shared,
 * a deliberate tradeoff for time rather than a cross-package refactor.
 * If this drifts from that copy, both need updating together.
 */
function parseMerchantReads(raw: readonly string[]): { sku: string; text: string; marked_untrusted: true }[] {
  const pattern =
    /sku=(\S+)\s+category=(\S+)\s+price_paise=(\S+)\s+in_stock=(\S+)\s*\n<untrusted_merchant_content>\n([\s\S]*?)\n<\/untrusted_merchant_content>/g;
  const seen = new Set<string>();
  const items: { sku: string; text: string; marked_untrusted: true }[] = [];
  for (const block of raw) {
    for (const m of block.matchAll(pattern)) {
      const [, sku, , , , text] = m;
      if (!sku || seen.has(sku)) continue;
      seen.add(sku);
      items.push({ sku, text: text ?? "", marked_untrusted: true });
    }
  }
  return items;
}

/**
 * Assembles the full evidence bundle a dispute officer would need for one
 * trace: the authorisation decision, what the agent actually read and did,
 * and the raw ledger entries plus their own hash-chain verification result
 * — self-attesting, since payload_hash/prev_hash/entry_hash are exactly
 * what a recipient needs to recompute every hash independently
 * (computePayloadHash/computeEntryHash, packages/ledger/src/chain.ts), not
 * take this bundle's word for it.
 */
export async function buildBundle(tx: PrismaTx, traceId: string): Promise<DisputeBundle | null> {
  const entries = await read(tx, traceId);
  if (entries.length === 0) return null;

  const intent = payloadOf(entries, "intent");
  const decision = payloadOf(entries, "decision");
  const outcome = payloadOf(entries, "outcome");
  const stepUpResolved = payloadOf(entries, "step_up_resolved");
  const transcriptPayload = payloadOf(entries, "agent_transcript");

  let decisionKind = asString(decision?.["kind"]);
  let reasonCode = asString(decision?.["reason_code"]);
  if (outcome) {
    decisionKind = "ALLOW";
    reasonCode = "OK";
  } else if (stepUpResolved) {
    const verdict = asString(stepUpResolved["verdict"]);
    if (verdict === "reject") {
      decisionKind = "DENY";
      reasonCode = null;
    } else if (verdict === "approve" && asString(stepUpResolved["revalidated_kind"]) === "DENY") {
      decisionKind = "DENY";
      reasonCode = asString(stepUpResolved["revalidated_reason"]);
    }
  }

  const decisionEntry = entries.find((e) => e.eventType === "decision");

  let goal: string | null = null;
  const merchantReadsRaw: string[] = [];
  const toolCalls: { name: string; input: unknown; result: string | null }[] = [];
  if (transcriptPayload) {
    const transcript = transcriptPayload["transcript"] as
      | readonly (
          | { role: "user"; text: string }
          | { role: "assistant"; calls: readonly { id: string; name: string; input: unknown }[]; text: string }
          | { role: "tool_results"; results: readonly { id: string; name: string; content: string }[] }
        )[]
      | undefined;
    for (const item of transcript ?? []) {
      if (item.role === "user") {
        const match = /Goal:\s*(.+)/s.exec(item.text);
        if (match?.[1]) goal = match[1].trim();
      }
      if (item.role === "tool_results") {
        for (const r of item.results) merchantReadsRaw.push(r.content);
      }
    }
    // A second pass to pair each call with its result by id — tool_results
    // arrive in the transcript item AFTER the assistant item that made the
    // calls, so this can't be done in the single loop above.
    const resultsById = new Map<string, string>();
    for (const item of transcript ?? []) {
      if (item.role === "tool_results") {
        for (const r of item.results) resultsById.set(r.id, r.content);
      }
    }
    for (const item of transcript ?? []) {
      if (item.role === "assistant") {
        for (const call of item.calls) {
          toolCalls.push({ name: call.name, input: call.input, result: resultsById.get(call.id) ?? null });
        }
      }
    }
  }

  const chainResult = await verifyChain(tx);
  const ownSeqs = entries.map((e) => Number(e.seq));
  const traceFullyVerified = chainResult.ok
    ? true
    : !ownSeqs.some((seq) => seq >= Number(chainResult.brokenAt));

  return {
    trace_id: traceId,
    generated_at: new Date().toISOString(),
    mandate: {
      id: asString(intent?.["mandate_id"]) ?? "unknown",
      issuer: null,
      signature_verified: reasonCode !== "MANDATE_SIGNATURE_INVALID",
    },
    authorisation: {
      decision: decisionKind,
      reason_code: reasonCode,
      amount_paise: asString(outcome?.["amount_paise"]) ?? asString(decision?.["amount_paise"]),
      evaluated_at: decisionEntry ? decisionEntry.ts.toISOString() : null,
    },
    agent: {
      model_id: asString(intent?.["model_id"]),
      goal,
      rationale: asString(intent?.["agent_rationale"]),
      tool_calls: toolCalls,
    },
    merchant_content_read: parseMerchantReads(merchantReadsRaw),
    execution: outcome
      ? {
          order_id: asString(outcome["order_id"]),
          status: asString(outcome["status"]),
          idempotency_key: asString(outcome["idempotency_key"]),
        }
      : null,
    chain: {
      entries: entries.map((e) => ({
        seq: e.seq.toString(),
        ts: e.ts.toISOString(),
        actor: e.actor,
        event_type: e.eventType,
        payload: e.payload,
        payload_hash: e.payloadHash,
        prev_hash: e.prevHash,
        entry_hash: e.entryHash,
      })),
      global_chain_ok: chainResult.ok,
      checked_through_seq: chainResult.ok ? chainResult.checked.toString() : null,
      head: chainResult.ok ? chainResult.head : null,
      trace_fully_verified: traceFullyVerified,
    },
  };
}

export async function buildBundleStandalone(traceId: string): Promise<DisputeBundle | null> {
  return prisma.$transaction((tx) => buildBundle(tx, traceId));
}
