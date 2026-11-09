import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { prisma, type PrismaTx } from "@praman/db";
import { amountIfPresent, read, readCurrency, verifyChain, type LedgerEntryRecord } from "@praman/ledger";
import { canonical, type Currency } from "@praman/shared";

/**
 * The bundle anyone holding a trace id can fetch at /dispute/:id. It says whether the
 * mandate checked out and never shows what the mandate allows: an agent given
 * dispute_url must not learn its own limits (D-08). The owner's copy, which has the
 * mandate and its signature, is OwnerDisputeBundle.
 */
export interface DisputeBundle {
  readonly trace_id: string;
  readonly generated_at: string;
  readonly mandate: {
    readonly id: string;
    /** Which signing key verified it. Null on traces recorded before the mandate went on the intent row (D-79). */
    readonly key_id: string | null;
    /**
     * Whether the signature checks out. "recomputed": this trace's own signed mandate
     * was verified with Ed25519 just now. "inferred": an older trace with no mandate on
     * it, so this is true unless its decision was MANDATE_SIGNATURE_INVALID.
     */
    readonly signature_verified: boolean;
    readonly signature_check: "recomputed" | "inferred";
    /**
     * sha256 of the canonical JSON of { document, signature }. Lets a holder of the full
     * mandate show it is the one decided under. It covers the signature, which is
     * withheld here, so hashing a guessed mandate can't reproduce it. Null on older traces.
     */
    readonly signed_sha256: string | null;
  };
  readonly authorisation: {
    readonly decision: string | null;
    readonly reason_code: string | null;
    readonly amount_minor: string | null;
    /** Null when there is no amount, as on a DENY. */
    readonly currency: Currency | null;
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
    readonly rail: string | null;
    /**
     * True when the rail's latest answer is "failed" or "mismatch". The authorisation
     * above is still Praman's decision; this says the money didn't move as authorised.
     * The trace page shows both as a failure, not as "Allowed".
     */
    readonly failed: boolean;
    /** The rail's own code on a failure (D-32). */
    readonly failure_code: string | null;
    /** What the rail said, on a mismatch: its status and the money it named (D-33). */
    readonly rail_reported: { readonly status: string | null; readonly amount_minor: string | null; readonly currency: string | null } | null;
    /**
     * "saved_method_no_buyer": the order's first outcome is a PayPal capture, which
     * only a charge to a saved payment method gives, with nobody at PayPal (D-49, D-50).
     * "buyer_checkout": created, then captured after the buyer approved at PayPal.
     */
    readonly paid_by: "saved_method_no_buyer" | "buyer_checkout" | null;
  } | null;
  /** The approval, when the decision was a step-up someone resolved. Null means nobody approved or rejected anything. */
  readonly approval: {
    readonly verdict: string | null;
    /**
     * "test_harness" when the intent came from the demo's concurrency harness (model id
     * "harness/..."), which approves its own first purchase in code. Otherwise a person.
     * Same reading as apps/receipt-ui/src/data.ts.
     */
    readonly by: "person" | "test_harness";
  } | null;
  /**
   * The latest refund of this trace's payment, when a person asked for one (D-66).
   * "requested" means no answer is recorded yet. Same reading as refundOf in
   * apps/receipt-ui/src/data.ts.
   */
  readonly refund: {
    readonly status: "requested" | "refunded" | "pending" | "failed" | "mismatch";
    readonly refund_id: string | null;
    readonly amount_minor: string | null;
    readonly currency: string | null;
    /** "operator" from `pnpm refund`, "demo_visitor" from the demo's trace page. Never an agent. */
    readonly requested_by: string | null;
    readonly requested_at: string;
    readonly failure_code: string | null;
    /** Always false. A refund gives no budget back to the mandate, whatever its status (D-67). */
    readonly budget_returned: false;
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
      /**
       * Payload fields left out of this copy, in sorted order. With any listed, the
       * payload can't be rehashed to payload_hash here, and entry_hash can still be
       * recomputed from payload_hash. Empty on the owner's copy (D-84).
       */
      readonly withheld_fields: readonly string[];
    }[];
    /** The full ledger's own integrity as of build time — recomputed live, not cached. */
    readonly global_chain_ok: boolean;
    readonly checked_through_seq: string | null;
    readonly head: string | null;
    /** Whether every one of THIS trace's own entries falls inside the verified range. */
    readonly trace_fully_verified: boolean;
  };
}

/**
 * The copy for someone who proved they own the trace: the demo session that made it,
 * or an operator at the local CLI. To check the mandate yourself: Ed25519 over the
 * canonical JSON of `document` (sorted keys, no whitespace), with `public_key_pem`.
 * It is the key Praman verified against when it decided, so it shows the mandate
 * wasn't altered, not who holds the key.
 */
export interface OwnerDisputeBundle extends Omit<DisputeBundle, "mandate"> {
  readonly mandate: DisputeBundle["mandate"] & {
    /** issuer_id from the signed mandate. Null on older traces. */
    readonly issuer: string | null;
    readonly signed: { readonly document: unknown; readonly signature: SignatureBlock; readonly public_key_pem: string } | null;
  };
}

interface SignatureBlock {
  readonly alg: string;
  readonly key_id: string;
  readonly value: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function signedMandateOf(intent: Record<string, unknown> | null): NonNullable<OwnerDisputeBundle["mandate"]["signed"]> | null {
  const signed = intent?.["signed_mandate"];
  const publicKey = intent?.["public_key_pem"];
  if (!isRecord(signed) || typeof publicKey !== "string") return null;
  const { document, signature } = signed;
  if (!isRecord(document) || !isRecord(signature)) return null;
  const { alg, key_id: keyId, value } = signature;
  if (typeof alg !== "string" || typeof keyId !== "string" || typeof value !== "string") return null;
  return { document, signature: { alg, key_id: keyId, value }, public_key_pem: publicKey };
}

/** Checks the mandate on the bundle itself, the way an outsider would. Any malformed part counts as not verified. */
function signatureHolds(signed: NonNullable<OwnerDisputeBundle["mandate"]["signed"]>): boolean {
  if (signed.signature.alg !== "Ed25519") return false;
  try {
    return cryptoVerify(null, Buffer.from(canonical(signed.document), "utf8"), createPublicKey(signed.public_key_pem), Buffer.from(signed.signature.value, "base64url"));
  } catch {
    return false;
  }
}

function signedHash(signed: NonNullable<OwnerDisputeBundle["mandate"]["signed"]>): string {
  return createHash("sha256").update(canonical({ document: signed.document, signature: signed.signature }), "utf8").digest("hex");
}

/**
 * Fields no public copy of a row may carry. `signed_mandate` and `public_key_pem` are
 * the mandate itself, `detail` can name a limit ("exceeds total budget 15000"), and
 * `redaction_salt` is what keeps a row's hash from confirming a guess at those.
 */
const WITHHELD_FIELDS: ReadonlySet<string> = new Set(["signed_mandate", "public_key_pem", "detail", "redaction_salt"]);

/** A step-up's reason says whether a threshold was crossed. The agent's own view drops it (redact), so the public one does too. */
function isStepUpCode(v: unknown): boolean {
  return typeof v === "string" && v.startsWith("STEP_UP_");
}

/**
 * A row's payload as any public copy may carry it, and the names of the fields left
 * out. The one place that decides what a public page or bundle shows of a payload.
 */
export function publicPayload(payload: unknown): { payload: unknown; withheld: string[] } {
  if (!isRecord(payload)) return { payload, withheld: [] };
  const kept: Record<string, unknown> = {};
  const withheld: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (WITHHELD_FIELDS.has(key) || ((key === "reason_code" || key === "revalidated_reason") && isStepUpCode(value))) withheld.push(key);
    else kept[key] = value;
  }
  return { payload: kept, withheld: withheld.sort() };
}

function toPublicBundle(owner: OwnerDisputeBundle): DisputeBundle {
  const { issuer: _issuer, signed: _signed, ...mandate } = owner.mandate;
  return {
    ...owner,
    mandate,
    authorisation: { ...owner.authorisation, reason_code: isStepUpCode(owner.authorisation.reason_code) ? null : owner.authorisation.reason_code },
    chain: {
      ...owner.chain,
      entries: owner.chain.entries.map((e) => {
        const { payload, withheld } = publicPayload(e.payload);
        return { ...e, payload, withheld_fields: withheld };
      }),
    },
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
 * The same reading as apps/receipt-ui/src/data.ts, kept as a copy like the parser
 * below. An order's first outcome is the order and its amount, its last is where it
 * stands (D-40). A capture refused after the last outcome is the answer that stands,
 * and only a proven holder's refusal counts (D-25).
 */
function finalState(entries: readonly LedgerEntryRecord[]): {
  first: Record<string, unknown> | null;
  last: Record<string, unknown> | null;
  captureRefusal: LedgerEntryRecord | null;
} {
  const outcomes = entries.filter((e) => e.eventType === "outcome");
  const lastOutcome = outcomes.at(-1);
  const decisions = entries.filter((e) => e.eventType === "capture_decision" && typeof (e.payload as Record<string, unknown>)["mandate_id"] === "string");
  const lastDecision = decisions.at(-1);
  const stands =
    lastDecision !== undefined &&
    (lastOutcome === undefined || lastDecision.seq > lastOutcome.seq) &&
    (lastDecision.payload as Record<string, unknown>)["kind"] === "DENY";
  return {
    first: outcomes[0] ? (outcomes[0].payload as Record<string, unknown>) : null,
    last: lastOutcome ? (lastOutcome.payload as Record<string, unknown>) : null,
    captureRefusal: stands ? lastDecision : null,
  };
}

const REFUND_STATUSES = ["refunded", "pending", "failed", "mismatch"] as const;

/** Same reading as refundOf in apps/receipt-ui/src/data.ts: the latest request, and what became of it. */
function refundOf(entries: readonly LedgerEntryRecord[]): DisputeBundle["refund"] {
  const request = entries.filter((e) => e.eventType === "refund_requested").at(-1);
  if (request === undefined) return null;
  const req = request.payload as Record<string, unknown>;
  const key = asString(req["refund_key"]);
  const answer = entries.filter((e) => e.eventType === "refund_outcome" && e.seq > request.seq && asString((e.payload as Record<string, unknown>)["refund_key"]) === key).at(-1);
  const out = answer ? (answer.payload as Record<string, unknown>) : null;
  const status = REFUND_STATUSES.find((s) => s === out?.["status"]) ?? "requested";
  const source = out ?? req;
  return {
    status,
    refund_id: asString(out?.["refund_id"]),
    amount_minor: amountIfPresent(source),
    currency: asString(source["currency"]),
    requested_by: asString(req["requested_by"]),
    requested_at: request.ts.toISOString(),
    failure_code: status === "failed" || status === "mismatch" ? asString(out?.["failure_code"]) : null,
    budget_returned: false,
  };
}

/** Same reading as paymentOf in apps/receipt-ui/src/data.ts. */
function paidBy(first: Record<string, unknown> | null, last: Record<string, unknown> | null): "saved_method_no_buyer" | "buyer_checkout" | null {
  if (first === null || last === null || asString(first["rail"]) !== "paypal") return null;
  const firstStatus = asString(first["status"]);
  if (firstStatus === "captured" && !("capture_key" in first)) return "saved_method_no_buyer";
  if (firstStatus === "created" && asString(last["status"]) === "captured") return "buyer_checkout";
  return null;
}

/**
 * Same tool-output format runTool() (apps/buyer-agent/src/agent.ts)
 * produces, parsed back into per-SKU records — duplicated from
 * apps/receipt-ui/src/data.ts's parseMerchantReads() rather than shared,
 * a deliberate tradeoff for time rather than a cross-package refactor.
 * If this drifts from that copy, both need updating together. Transcripts
 * recorded before the rename to minor units say price_paise, and they sit in
 * the ledger for good, so both names match. Only newer ones show a currency.
 */
function parseMerchantReads(raw: readonly string[]): { sku: string; text: string; marked_untrusted: true }[] {
  const pattern =
    /sku=(\S+)\s+category=(\S+)\s+price_(?:paise|minor)=(\S+)(?:\s+currency=\S+)?\s+in_stock=(\S+)\s*\n<untrusted_merchant_content>\n([\s\S]*?)\n<\/untrusted_merchant_content>/g;
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
export async function buildOwnerBundle(tx: PrismaTx, traceId: string): Promise<OwnerDisputeBundle | null> {
  const entries = await read(tx, traceId);
  if (entries.length === 0) return null;

  const intent = payloadOf(entries, "intent");
  const decision = payloadOf(entries, "decision");
  const { first: outcome, last: latestOutcome, captureRefusal } = finalState(entries);
  const stepUpResolved = payloadOf(entries, "step_up_resolved");
  const transcriptPayload = payloadOf(entries, "agent_transcript");

  let decisionKind = asString(decision?.["kind"]);
  let reasonCode = asString(decision?.["reason_code"]);
  if (outcome && captureRefusal) {
    decisionKind = "DENY";
    reasonCode = asString((captureRefusal.payload as Record<string, unknown>)["reason_code"]);
  } else if (outcome) {
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

  // When a refused capture is the answer that stands, it was decided then, not at the first decision.
  const decisionEntry = (outcome ? captureRefusal : null) ?? entries.find((e) => e.eventType === "decision");

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

  const amountMinor = (outcome && amountIfPresent(outcome)) ?? (decision && amountIfPresent(decision));

  const signed = signedMandateOf(intent);
  const issuer = signed !== null && isRecord(signed.document) ? asString(signed.document["issuer_id"]) : null;

  return {
    trace_id: traceId,
    generated_at: new Date().toISOString(),
    mandate: {
      id: asString(intent?.["mandate_id"]) ?? "unknown",
      key_id: signed === null ? null : signed.signature.key_id,
      issuer,
      signature_verified: signed === null ? reasonCode !== "MANDATE_SIGNATURE_INVALID" : signatureHolds(signed),
      signature_check: signed === null ? "inferred" : "recomputed",
      signed_sha256: signed === null ? null : signedHash(signed),
      signed,
    },
    authorisation: {
      decision: decisionKind,
      reason_code: reasonCode,
      amount_minor: amountMinor,
      currency: amountMinor === null ? null : readCurrency(outcome ?? decision ?? {}),
      evaluated_at: decisionEntry ? decisionEntry.ts.toISOString() : null,
    },
    agent: {
      model_id: asString(intent?.["model_id"]),
      goal,
      rationale: asString(intent?.["agent_rationale"]),
      tool_calls: toolCalls,
    },
    merchant_content_read: parseMerchantReads(merchantReadsRaw),
    execution: latestOutcome
      ? {
          order_id: asString(latestOutcome["order_id"]) ?? asString(outcome?.["order_id"]),
          status: asString(latestOutcome["status"]),
          idempotency_key: asString(latestOutcome["idempotency_key"]),
          rail: asString(latestOutcome["rail"]),
          failed: latestOutcome["status"] === "failed" || latestOutcome["status"] === "mismatch",
          failure_code: latestOutcome["status"] === "failed" ? asString(latestOutcome["failure_code"]) : null,
          rail_reported:
            latestOutcome["status"] === "mismatch"
              ? { status: asString(latestOutcome["rail_status"]), amount_minor: asString(latestOutcome["rail_amount_minor"]), currency: asString(latestOutcome["rail_currency"]) }
              : null,
          paid_by: paidBy(outcome, latestOutcome),
        }
      : null,
    approval: stepUpResolved
      ? { verdict: asString(stepUpResolved["verdict"]), by: (asString(intent?.["model_id"]) ?? "").startsWith("harness/") ? "test_harness" : "person" }
      : null,
    refund: refundOf(entries),
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
        withheld_fields: [],
      })),
      global_chain_ok: chainResult.ok,
      checked_through_seq: chainResult.ok ? chainResult.checked.toString() : null,
      head: chainResult.ok ? chainResult.head : null,
      trace_fully_verified: traceFullyVerified,
    },
  };
}

/** The copy /dispute/:id serves to anyone with the trace id. It carries no mandate limits (D-84). */
export async function buildBundle(tx: PrismaTx, traceId: string): Promise<DisputeBundle | null> {
  const owner = await buildOwnerBundle(tx, traceId);
  return owner === null ? null : toPublicBundle(owner);
}

export async function buildBundleStandalone(traceId: string): Promise<DisputeBundle | null> {
  return prisma.$transaction((tx) => buildBundle(tx, traceId));
}

export async function buildOwnerBundleStandalone(traceId: string): Promise<OwnerDisputeBundle | null> {
  return prisma.$transaction((tx) => buildOwnerBundle(tx, traceId));
}
