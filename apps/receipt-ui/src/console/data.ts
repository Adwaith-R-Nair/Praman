import { prisma } from "@praman/db";
import { amountIfPresent, computeEntryHash, computePayloadHash, deriveState, GENESIS_HASH, readCurrency, verifyChain, type EventType, type VerifyResult } from "@praman/ledger";
import { formatMoney, isCurrency, minorFromJSON, REASON_CODES, type Currency, type ReasonCode } from "@praman/shared";
import { BREAK_REASON_PLAIN, EVENT_TYPE_PLAIN, REASON_CODE_PLAIN } from "../reason-codes.js";

/**
 * The operator console's data: ledger rows as the grid shows them, each with its own
 * hash check, the whole chain verified once, and what the three charts draw. Built on
 * the server from the ledger alone. Nothing here decides anything: it reads rows that
 * are already written, and it never sends a payload, a transcript or merchant text,
 * only ids, codes, amounts and hashes.
 */

/**
 * Which rows a console may see. A demo visitor sees their own session's mandates. Only a
 * local operator sees everything. The public sample page reads one fixed session's
 * mandates through loadPublicConsoleData, never through loadConsoleData directly.
 */
export type ConsoleScope = { readonly kind: "mandates"; readonly mandateIds: readonly string[] } | { readonly kind: "all"; readonly limit: number };

/** A mandate's signed budget, when this server holds the signed document. */
export interface Budget {
  readonly maxTotalMinor: string;
  readonly currency: Currency;
}

/** A stored ledger row, as read. The event type stays the stored string, so an unknown one is shown as it is. */
export interface ConsoleEntry {
  readonly seq: bigint;
  readonly traceId: string;
  readonly ts: Date;
  readonly actor: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly payloadHash: string;
  readonly prevHash: string;
  readonly entryHash: string;
}

/** One row's own check, recomputed here from its stored fields with the ledger's hash functions. */
export interface EntryCheck {
  /** sha256 of the stored payload matches the stored payload hash. */
  readonly payloadIntact: boolean;
  /** The entry hash recomputed from prev hash, seq, time, actor, event type and payload hash matches. */
  readonly fieldsIntact: boolean;
  /** The row's prev hash is the entry hash of the row before it. Null when that row wasn't read. */
  readonly linked: boolean | null;
  readonly recomputedPayloadHash: string;
  readonly recomputedEntryHash: string | null;
}

export interface ConsoleRow {
  readonly seq: string;
  readonly ts: string;
  readonly traceId: string;
  readonly actor: string;
  readonly eventType: string;
  readonly eventPlain: string;
  readonly mandateId: string | null;
  /** True when the mandate id is only claimed: the row came from a mandate whose signature didn't verify. */
  readonly mandateClaimed: boolean;
  readonly merchantId: string | null;
  readonly rail: string | null;
  readonly amountMinor: string | null;
  readonly currency: Currency | null;
  readonly amount: string | null;
  /** ALLOW, STEP_UP or DENY on a decision; APPROVED or REJECTED on a step-up; REVOKED on a revocation. */
  readonly decision: string | null;
  /** The outcome, call or settlement status: created, captured, released, failed, attempted... */
  readonly status: string | null;
  readonly reasonCode: string | null;
  readonly reasonPlain: string | null;
  readonly orderId: string | null;
  readonly captureId: string | null;
  /** The rail's refund id, on a refund outcome. */
  readonly refundId: string | null;
  readonly prevHash: string;
  readonly payloadHash: string;
  readonly entryHash: string;
  readonly check: EntryCheck;
  /** "intact" when all three checks hold, "altered" when a hash doesn't match, "unlinked" when only the link fails. */
  readonly hashVerdict: "intact" | "altered" | "unlinked";
  /** Whether the full chain walk from genesis reached and confirmed this row. */
  readonly chainVerified: boolean;
}

export interface ChainSummary {
  readonly ok: boolean;
  readonly checked: number;
  readonly head: string | null;
  readonly brokenAtSeq: string | null;
  readonly breakReason: string | null;
  readonly breakReasonPlain: string | null;
}

export interface SpendPoint {
  readonly ts: string;
  readonly seq: string;
  /** Spent or held after this row, in minor units. */
  readonly heldMinor: string;
  readonly label: string;
}

export interface SpendSeries {
  readonly mandateId: string;
  readonly currency: Currency;
  readonly budgetMinor: string | null;
  readonly budgetLabel: string | null;
  /** What deriveState() counts now: the number evaluate() is given. The series ends here. */
  readonly spentNowMinor: string;
  readonly spentNowLabel: string;
  readonly revoked: boolean;
  readonly points: readonly SpendPoint[];
}

export interface ReasonCount {
  readonly reasonCode: string;
  readonly reasonPlain: string | null;
  readonly allow: number;
  readonly stepUp: number;
  readonly deny: number;
}

export interface RailCount {
  readonly rail: string;
  readonly statuses: Readonly<Record<string, number>>;
}

export interface ConsoleData {
  readonly generatedAt: string;
  readonly rows: readonly ConsoleRow[];
  /** True when there were more rows in scope than were sent. */
  readonly truncated: boolean;
  readonly chain: ChainSummary;
  readonly spend: readonly SpendSeries[];
  readonly decisions: readonly ReasonCount[];
  readonly rails: readonly RailCount[];
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function isReasonCode(code: string): code is ReasonCode {
  return REASON_CODES.some((c) => c === code);
}

function isEventType(value: string): value is EventType {
  return Object.prototype.hasOwnProperty.call(EVENT_TYPE_PLAIN, value);
}

function payloadOf(entry: ConsoleEntry): Record<string, unknown> {
  const p = entry.payload;
  return typeof p === "object" && p !== null && !Array.isArray(p) ? { ...p } : {};
}

/**
 * Recomputes one row's hashes with the same functions append() and verifyChain() use.
 * `prevEntryHash` is the entry hash of the row at seq - 1, GENESIS_HASH for the first
 * row, or null when it wasn't read. A row whose stored fields can't even be hashed
 * (a malformed hash or time) counts as altered.
 */
export function checkEntry(entry: ConsoleEntry, prevEntryHash: string | null): EntryCheck {
  const recomputedPayloadHash = computePayloadHash(entry.payload);
  let recomputedEntryHash: string | null = null;
  try {
    recomputedEntryHash = computeEntryHash({ prevHash: entry.prevHash, seq: entry.seq, ts: entry.ts, actor: entry.actor, eventType: entry.eventType, payloadHash: entry.payloadHash });
  } catch {
    recomputedEntryHash = null;
  }
  return {
    payloadIntact: recomputedPayloadHash === entry.payloadHash,
    fieldsIntact: recomputedEntryHash !== null && recomputedEntryHash === entry.entryHash,
    linked: prevEntryHash === null ? null : entry.prevHash === prevEntryHash,
    recomputedPayloadHash,
    recomputedEntryHash,
  };
}

function verdictOf(check: EntryCheck): ConsoleRow["hashVerdict"] {
  if (!check.payloadIntact || !check.fieldsIntact) return "altered";
  if (check.linked === false) return "unlinked";
  return "intact";
}

export function summariseChain(result: VerifyResult): ChainSummary {
  if (result.ok) return { ok: true, checked: result.checked, head: result.head, brokenAtSeq: null, breakReason: null, breakReasonPlain: null };
  return { ok: false, checked: 0, head: null, brokenAtSeq: result.brokenAt.toString(), breakReason: result.reason, breakReasonPlain: BREAK_REASON_PLAIN[result.reason] };
}

function money(amountMinor: string | null, currency: Currency | null): string | null {
  if (amountMinor === null || currency === null || !/^\d+$/.test(amountMinor)) return null;
  return formatMoney(minorFromJSON(amountMinor), currency);
}

function currencyOf(payload: Record<string, unknown>): Currency | null {
  try {
    return readCurrency(payload);
  } catch {
    return null;
  }
}

/** What a row says about a decision, in the grid's words. */
function decisionOf(eventType: string, p: Record<string, unknown>): { decision: string | null; reasonCode: string | null } {
  switch (eventType) {
    case "decision":
    case "capture_decision":
      return { decision: str(p["kind"]), reasonCode: str(p["reason_code"]) };
    case "step_up_resolved": {
      const verdict = str(p["verdict"]);
      const revalidatedDeny = str(p["revalidated_kind"]) === "DENY";
      return {
        decision: verdict === "approve" ? (revalidatedDeny ? "DENY" : "APPROVED") : verdict === "reject" ? "REJECTED" : verdict,
        reasonCode: revalidatedDeny ? str(p["revalidated_reason"]) : null,
      };
    }
    case "mandate_revoked":
      return { decision: "REVOKED", reasonCode: null };
    default:
      return { decision: null, reasonCode: null };
  }
}

/** Shapes one ledger row for the grid. The trace's intent fills in the mandate and merchant when the row itself doesn't name them. */
export function toRow(entry: ConsoleEntry, check: EntryCheck, chainVerified: boolean, intentOfTrace: Record<string, unknown> | null): ConsoleRow {
  const p = payloadOf(entry);
  const claimed = str(p["claimed_mandate_id"]);
  const own = str(p["mandate_id"]);
  const mandateId = own ?? claimed ?? str(intentOfTrace?.["mandate_id"]);
  const amountMinor = amountIfPresent(p);
  const currency = amountMinor === null ? null : currencyOf(p);
  const { decision, reasonCode } = decisionOf(entry.eventType, p);
  const isOutcomeLike = ["outcome", "api_call", "settlement", "refund_requested", "refund_outcome"].includes(entry.eventType);
  return {
    seq: entry.seq.toString(),
    ts: entry.ts.toISOString(),
    traceId: entry.traceId,
    actor: entry.actor,
    eventType: entry.eventType,
    eventPlain: isEventType(entry.eventType) ? EVENT_TYPE_PLAIN[entry.eventType] : entry.eventType,
    mandateId,
    mandateClaimed: own === null && claimed !== null,
    merchantId: str(p["merchant_id"]) ?? str(intentOfTrace?.["merchant_id"]),
    rail: str(p["rail"]),
    amountMinor,
    currency,
    amount: money(amountMinor, currency),
    decision,
    status: isOutcomeLike ? str(p["status"]) : null,
    reasonCode,
    reasonPlain: reasonCode !== null && isReasonCode(reasonCode) ? REASON_CODE_PLAIN[reasonCode] : null,
    orderId: str(p["order_id"]),
    captureId: str(p["payment_id"]),
    refundId: entry.eventType === "refund_outcome" ? str(p["refund_id"]) : null,
    prevHash: entry.prevHash,
    payloadHash: entry.payloadHash,
    entryHash: entry.entryHash,
    check,
    hashVerdict: verdictOf(check),
    chainVerified,
  };
}

/**
 * Spent or held over time for one mandate, row by row, for the chart. It follows the
 * rules deriveState() counts by (D-30, D-42): an attempted order call is held until an
 * outcome answers it; an order holds the largest amount any of its outcomes names; a
 * release gives an order's hold back. A refund gives nothing back (D-67), so its rows
 * don't move the line. The chart ends at deriveState()'s own number,
 * which is the one evaluate() is given; this line only shows how it got there.
 */
export function spendTimeline(entries: readonly ConsoleEntry[], currency: Currency): SpendPoint[] {
  const attempts = new Map<string, bigint>();
  const orders = new Map<string, bigint>();
  const ordersByKey = new Map<string, string[]>();
  const points: SpendPoint[] = [];
  const total = (): bigint => [...attempts.values(), ...orders.values()].reduce((a, b) => a + b, 0n);
  const amountOf = (p: Record<string, unknown>): bigint => {
    const raw = amountIfPresent(p);
    const reported = str(p["rail_amount_minor"]);
    const authorised = raw !== null && /^\d+$/.test(raw) ? BigInt(raw) : 0n;
    const rail = reported !== null && /^\d+$/.test(reported) && p["rail_currency"] === p["currency"] ? BigInt(reported) : 0n;
    return rail > authorised ? rail : authorised;
  };

  for (const entry of entries) {
    const p = payloadOf(entry);
    const key = str(p["idempotency_key"]);
    const before = total();
    if (entry.eventType === "api_call" && p["status"] === "attempted" && p["operation"] !== "orders.capture") {
      attempts.set(key ?? `trace:${entry.traceId}`, amountOf(p));
    } else if (entry.eventType === "outcome") {
      attempts.delete(key ?? `trace:${entry.traceId}`);
      attempts.delete(`trace:${entry.traceId}`);
      const status = str(p["status"]);
      const orderId = str(p["order_id"]) ?? key ?? `seq:${entry.seq.toString()}`;
      if (status === "released") {
        const freed = str(p["order_id"]) !== null ? [orderId] : key === null ? [] : (ordersByKey.get(key) ?? []);
        for (const id of freed) orders.set(id, 0n);
      } else if (status === "created" || status === "captured" || status === "mismatch") {
        const held = orders.get(orderId) ?? 0n;
        const amount = amountOf(p);
        orders.set(orderId, amount > held ? amount : held);
        if (key !== null) ordersByKey.set(key, [...(ordersByKey.get(key) ?? []).filter((id) => id !== orderId), orderId]);
      }
    } else {
      continue;
    }
    const after = total();
    if (after === before && points.length > 0) continue;
    points.push({ ts: entry.ts.toISOString(), seq: entry.seq.toString(), heldMinor: after.toString(), label: formatMoney(minorFromJSON(after.toString()), currency) });
  }
  return points;
}

/** Decisions by reason code: each decision and capture re-check row, split by what it decided. */
export function countDecisions(rows: readonly ConsoleRow[]): ReasonCount[] {
  const counts = new Map<string, { allow: number; stepUp: number; deny: number }>();
  for (const row of rows) {
    if ((row.eventType !== "decision" && row.eventType !== "capture_decision") || row.reasonCode === null) continue;
    const c = counts.get(row.reasonCode) ?? { allow: 0, stepUp: 0, deny: 0 };
    if (row.decision === "ALLOW") c.allow += 1;
    else if (row.decision === "STEP_UP") c.stepUp += 1;
    else if (row.decision === "DENY") c.deny += 1;
    counts.set(row.reasonCode, c);
  }
  return [...counts.entries()]
    .map(([reasonCode, c]) => ({ reasonCode, reasonPlain: isReasonCode(reasonCode) ? REASON_CODE_PLAIN[reasonCode] : null, ...c }))
    .sort((a, b) => b.allow + b.stepUp + b.deny - (a.allow + a.stepUp + a.deny) || a.reasonCode.localeCompare(b.reasonCode));
}

/**
 * Orders by rail, counted once each at their latest outcome: captured, created, released,
 * failed or mismatch. A captured order whose money went back is counted as refunded. A
 * refund that is pending, refused or open leaves the order as captured, since the money
 * is still with the merchant.
 */
export function countRails(rows: readonly ConsoleRow[]): RailCount[] {
  const latest = new Map<string, { rail: string; status: string }>();
  const refunded = new Set<string>();
  for (const row of rows) {
    if (row.eventType === "refund_outcome" && row.status === "refunded" && row.orderId !== null) refunded.add(row.orderId);
    if (row.eventType !== "outcome" || row.rail === null || row.status === null) continue;
    // An order is its order id; an outcome with none (a create the rail refused) is its own trace's attempt.
    latest.set(row.orderId ?? `trace:${row.traceId}`, { rail: row.rail, status: row.status });
  }
  for (const id of refunded) {
    const order = latest.get(id);
    if (order?.status === "captured") latest.set(id, { rail: order.rail, status: "refunded" });
  }
  const byRail = new Map<string, Record<string, number>>();
  for (const { rail, status } of latest.values()) {
    const statuses = byRail.get(rail) ?? {};
    statuses[status] = (statuses[status] ?? 0) + 1;
    byRail.set(rail, statuses);
  }
  return [...byRail.entries()].map(([rail, statuses]) => ({ rail, statuses })).sort((a, b) => a.rail.localeCompare(b.rail));
}

/**
 * Loads the console for one scope. For a visitor that is every trace that names one of
 * their mandates, which takes in the revocation row too. For a local operator it is the
 * newest `limit` rows of the whole ledger. The chain is walked from genesis once, the
 * same walk `pnpm verify-ledger` does.
 */
export async function loadConsoleData(scope: ConsoleScope, budgets: ReadonlyMap<string, Budget>, now: Date): Promise<ConsoleData> {
  return prisma.$transaction(async (tx) => {
    let raw: Awaited<ReturnType<typeof tx.ledgerEntry.findMany>>;
    let truncated = false;
    if (scope.kind === "mandates") {
      const ids = [...scope.mandateIds];
      const traces = ids.length === 0 ? [] : await tx.$queryRaw<{ trace_id: string }[]>`
        SELECT DISTINCT trace_id FROM ledger_entry WHERE payload->>'mandate_id' = ANY(${ids})
      `;
      raw = traces.length === 0 ? [] : await tx.ledgerEntry.findMany({ where: { traceId: { in: traces.map((t) => t.trace_id) } }, orderBy: { seq: "asc" } });
    } else {
      const newest = await tx.ledgerEntry.findMany({ orderBy: { seq: "desc" }, take: scope.limit + 1 });
      truncated = newest.length > scope.limit;
      raw = newest.slice(0, scope.limit).reverse();
    }
    const entries: readonly ConsoleEntry[] = raw;

    const prevSeqs = entries.map((e) => e.seq - 1n).filter((s) => s >= 1n);
    const prevRows = prevSeqs.length === 0 ? [] : await tx.ledgerEntry.findMany({ where: { seq: { in: prevSeqs } }, select: { seq: true, entryHash: true } });
    const prevHashBySeq = new Map(prevRows.map((r) => [r.seq.toString(), r.entryHash]));
    const chainResult = await verifyChain(tx);
    const chain = summariseChain(chainResult);

    const intents = new Map<string, Record<string, unknown>>();
    for (const e of entries) if (e.eventType === "intent" && !intents.has(e.traceId)) intents.set(e.traceId, payloadOf(e));

    const rows = entries.map((e) => {
      const prev = e.seq === 1n ? GENESIS_HASH : (prevHashBySeq.get((e.seq - 1n).toString()) ?? null);
      const verified = chainResult.ok || e.seq < chainResult.brokenAt;
      return toRow(e, checkEntry(e, prev), verified, intents.get(e.traceId) ?? null);
    });

    // Spend per mandate: only mandates with a verified id, in one currency each.
    const mandateIds = scope.kind === "mandates" ? [...scope.mandateIds] : [...new Set(rows.flatMap((r) => (r.mandateId !== null && !r.mandateClaimed ? [r.mandateId] : [])))];
    const spend: SpendSeries[] = [];
    for (const mandateId of mandateIds) {
      const own = entries.filter((e) => str(payloadOf(e)["mandate_id"]) === mandateId);
      const budget = budgets.get(mandateId) ?? null;
      // Only a row with an amount says its currency. A row with none, like the intent, would read as INR.
      const withAmount = own.map(payloadOf).filter((p) => amountIfPresent(p) !== null);
      const currency = budget?.currency ?? withAmount.map(currencyOf).find((c): c is Currency => c !== null && isCurrency(c)) ?? null;
      if (currency === null) continue;
      const state = await deriveState(tx, mandateId);
      const spentNow = state.spent_minor.toString();
      spend.push({
        mandateId,
        currency,
        budgetMinor: budget?.maxTotalMinor ?? null,
        budgetLabel: budget === null ? null : money(budget.maxTotalMinor, budget.currency),
        spentNowMinor: spentNow,
        spentNowLabel: formatMoney(state.spent_minor, currency),
        revoked: state.revoked,
        points: spendTimeline(own, currency),
      });
    }

    return { generatedAt: now.toISOString(), rows, truncated, chain, spend, decisions: countDecisions(rows), rails: countRails(rows) };
  });
}

/** Shown in place of a step-up's reason on a public page. Fixed text, not a reason code. */
export const STEP_UP_REASON_WITHHELD = "Praman asked a person first. Why is withheld from public pages.";

/**
 * The copy of a console's data that anyone may read. It carries what a public trace page
 * and a public dispute bundle carry and no more (D-84): no signed budget, and no reason
 * on a row that asked a person, since a step-up's reason says a limit was crossed. A row
 * never holds a payload, so the signed mandate, a refusal's `detail` and a row's
 * redaction salt were never here to remove. The decisions chart is counted again from
 * the rows as published, so it can't show a code a row no longer does.
 */
export function publicConsoleData(data: ConsoleData): ConsoleData {
  const rows = data.rows.map((row) =>
    row.decision === "STEP_UP" || (row.reasonCode !== null && row.reasonCode.startsWith("STEP_UP_")) ? { ...row, reasonCode: null, reasonPlain: STEP_UP_REASON_WITHHELD } : row,
  );
  return {
    ...data,
    rows,
    spend: data.spend.map((s) => ({ ...s, budgetMinor: null, budgetLabel: null })),
    decisions: countDecisions(rows),
  };
}

/** One fixed set of mandates, for a public page. No budgets go in, and the result is the public copy. */
export async function loadPublicConsoleData(mandateIds: readonly string[], now: Date): Promise<ConsoleData> {
  return publicConsoleData(await loadConsoleData({ kind: "mandates", mandateIds }, new Map(), now));
}
