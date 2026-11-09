import type { LedgerEntryRecord } from "@praman/ledger";
import { isRail } from "@praman/shared";
import { compareOrder, type FieldCheck, type FieldResult, type RefundLookup } from "./compare.js";
import { viewTrace, type LedgerOrder, type LedgerTrace } from "./ledger-view.js";
import { readDispute, readDisputeIds, readOrder, readRefund, type PayPalDispute } from "./paypal-view.js";
import { READ_TOOL_NAMES, type PayPalReader, type ToolAnswer } from "./read-only-toolkit.js";

/** Every compared field agrees. */
export const EXIT_MATCH = 0;
/** At least one compared field differs. */
export const EXIT_MISMATCH = 1;
/** Nothing was compared: no PayPal order on the trace, or the ledger or PayPal could not be read. Not a pass. */
export const EXIT_NOT_AUDITED = 2;

/** How many disputes on one capture are read in full. */
const MAX_DISPUTES = 5;

/** Disputes are shown and never compared: the ledger keeps no dispute rows. */
export type DisputeNote =
  | { readonly kind: "not_looked" }
  | { readonly kind: "unreadable"; readonly why: string }
  | { readonly kind: "listed"; readonly disputes: readonly PayPalDispute[]; readonly unread: number };

export interface OrderAudit {
  readonly orderId: string;
  /** Empty when PayPal has no such order and the ledger records no capture on it. */
  readonly fields: readonly FieldCheck[];
  readonly skipped: string | null;
  readonly disputes: DisputeNote;
}

export interface Audited {
  readonly kind: "AUDITED";
  readonly traceId: string;
  readonly overall: FieldResult;
  readonly orders: readonly OrderAudit[];
}

export type AuditReport = Audited | { readonly kind: "NOT_AUDITED"; readonly traceId: string; readonly reason: string };

export interface AuditDeps {
  /** The trace's ledger rows, oldest first. Must not write. */
  readTrace(traceId: string): Promise<readonly LedgerEntryRecord[]>;
  /** Null when this process has no PayPal keys. Asked for only once the ledger shows a PayPal order. */
  paypal(): PayPalReader | null;
}

/** Writes a few sentences about a finished audit. Its lines are printed after the verdict and read by nothing. */
export type Narrator = (report: Audited) => Promise<readonly string[]>;

type Failure = Extract<ToolAnswer, { kind: "error" }>;
type OrderResult = { readonly kind: "ok"; readonly order: OrderAudit } | { readonly kind: "unreadable"; readonly why: string };

const why = (tool: string, failure: Failure): string => `${tool} answered ${failure.status === null ? failure.code : `HTTP ${failure.status}`}`;

async function disputesOn(reader: PayPalReader, captureId: string | null): Promise<DisputeNote> {
  if (captureId === null) return { kind: "not_looked" };
  const list = await reader.listDisputes(captureId);
  if (list.kind === "error") return { kind: "unreadable", why: why("list_disputes", list) };
  const ids = readDisputeIds(list.body);
  const disputes: PayPalDispute[] = [];
  for (const id of ids.slice(0, MAX_DISPUTES)) {
    const answer = await reader.getDispute(id);
    if (answer.kind === "error") return { kind: "unreadable", why: why("get_dispute", answer) };
    disputes.push(readDispute(answer.body));
  }
  return { kind: "listed", disputes, unread: ids.length - disputes.length };
}

async function auditOrder(reader: PayPalReader, ledger: LedgerOrder): Promise<OrderResult> {
  const answer = await reader.getOrder(ledger.orderId);
  if (answer.kind === "error") {
    if (answer.status !== 404) return { kind: "unreadable", why: why("get_order", answer) };
    // A paid order stays readable at PayPal, so its absence is a difference. An order
    // nobody paid is one the ledger never said holds money at PayPal.
    const fields: FieldCheck[] = ledger.status === "captured" ? [{ field: "order_id", ledger: ledger.orderId, paypal: "no order with this id", result: "MISMATCH" }] : [];
    const skipped = fields.length > 0 ? null : "PayPal has no order with this id, and the ledger records no capture on it, so there was nothing to compare.";
    return { kind: "ok", order: { orderId: ledger.orderId, fields, skipped, disputes: { kind: "not_looked" } } };
  }

  let lookup: RefundLookup = { kind: "not_asked" };
  const { refund } = ledger;
  if (refund.refundId !== null && refund.state !== "none" && refund.state !== "requested") {
    const refundAnswer = await reader.getRefund(refund.refundId);
    if (refundAnswer.kind === "ok") lookup = { kind: "found", refund: readRefund(refundAnswer.body) };
    else if (refundAnswer.status === 404) lookup = { kind: "absent" };
    else return { kind: "unreadable", why: why("get_refund", refundAnswer) };
  }

  const fields = compareOrder(ledger, readOrder(answer.body), lookup);
  return { kind: "ok", order: { orderId: ledger.orderId, fields, skipped: null, disputes: await disputesOn(reader, ledger.captureId) } };
}

/**
 * Compares one trace's ledger rows with PayPal's record of each order on it. The
 * verdict is this function's return value and nothing else: no model is involved.
 */
export async function auditTrace(deps: AuditDeps, traceId: string): Promise<AuditReport> {
  const notAudited = (reason: string): AuditReport => ({ kind: "NOT_AUDITED", traceId, reason });

  let trace: LedgerTrace;
  try {
    trace = viewTrace(await deps.readTrace(traceId));
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    return notAudited(`A ledger row on this trace can't be read (${err.message}).`);
  }
  if (trace.kind === "empty") return notAudited("No ledger rows have this trace id.");
  if (trace.kind === "no_paypal_order") {
    if (trace.ordersOnOtherRails === 0) return notAudited("This trace has no order: nothing was sent to a payment provider, or what was sent made none.");
    const rails = trace.rails.filter(isRail).join(" and ") || "another";
    return notAudited(`This trace's order is on the ${rails} rail, and the auditor reads PayPal only.`);
  }

  const reader = deps.paypal();
  if (reader === null) return notAudited("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are not set, so PayPal was not read.");

  const orders: OrderAudit[] = [];
  for (const order of trace.orders) {
    const result = await auditOrder(reader, order);
    if (result.kind === "unreadable") return notAudited(`PayPal could not be read: ${result.why}.`);
    orders.push(result.order);
  }

  const fields = orders.flatMap((order) => order.fields);
  if (fields.length === 0) return notAudited(orders[0]?.skipped ?? "No field could be compared.");
  return { kind: "AUDITED", traceId, overall: fields.every((field) => field.result === "MATCH") ? "MATCH" : "MISMATCH", orders };
}

export function exitCodeFor(report: AuditReport): number {
  if (report.kind === "NOT_AUDITED") return EXIT_NOT_AUDITED;
  return report.overall === "MATCH" ? EXIT_MATCH : EXIT_MISMATCH;
}

function disputeLine(note: DisputeNote): string | null {
  const label = "disputes at PayPal on this capture (shown, not compared: the ledger keeps no dispute rows)";
  if (note.kind === "not_looked") return null;
  if (note.kind === "unreadable") return `  ${label}: not read, ${note.why}`;
  if (note.disputes.length === 0 && note.unread === 0) return `  ${label}: none`;
  const shown = note.disputes.map((d) => {
    const amount = d.money.amountMinor === null ? "" : `, ${d.money.amountMinor.toString()} minor units ${d.money.currencyCode ?? ""}`.trimEnd();
    return `${d.id ?? "(unreadable id)"} ${d.status ?? "(unreadable status)"}, reason ${d.reason ?? "(unreadable)"}, stage ${d.stage ?? "(unreadable)"}${amount}`;
  });
  return `  ${label}: ${shown.join("; ")}${note.unread > 0 ? `; and ${note.unread} more not read` : ""}`;
}

function table(fields: readonly FieldCheck[]): string[] {
  const rows = [{ field: "field", ledger: "ledger", paypal: "PayPal", result: "result" }, ...fields];
  const width = (pick: (row: (typeof rows)[number]) => string): number => rows.reduce((max, row) => (pick(row).length > max ? pick(row).length : max), 0);
  const [f, l, p] = [width((r) => r.field), width((r) => r.ledger), width((r) => r.paypal)];
  return rows.map((r) => `  ${r.field.padEnd(f)}  ${r.ledger.padEnd(l)}  ${r.paypal.padEnd(p)}  ${r.result}`);
}

/** The whole printed verdict. Each line is built from checked values, never from PayPal's free text. */
export function renderReport(report: AuditReport): string[] {
  const head = `PayPal audit of trace ${report.traceId}`;
  if (report.kind === "NOT_AUDITED") return [head, `Not audited: ${report.reason}`, "Nothing was compared. This is neither a pass nor a fail."];

  const lines = [head, `Read through PayPal's Agent Toolkit with four read tools (${READ_TOOL_NAMES.join(", ")}). Nothing was written to the ledger or to PayPal.`];
  for (const order of report.orders) {
    lines.push("", `Order ${order.orderId}`);
    if (order.skipped !== null) lines.push(`  ${order.skipped}`);
    else lines.push(...table(order.fields));
    const disputes = disputeLine(order.disputes);
    if (disputes !== null) lines.push(disputes);
  }

  const fields = report.orders.flatMap((order) => order.fields);
  const differing = fields.filter((field) => field.result === "MISMATCH").map((field) => field.field);
  lines.push("");
  if (report.overall === "MATCH") {
    lines.push(`Overall: MATCH. ${fields.length} of ${fields.length} fields agree.`);
  } else {
    lines.push(`Overall: MISMATCH. ${differing.length} of ${fields.length} fields differ: ${differing.join(", ")}.`);
    lines.push("The ledger may be behind PayPal (run pnpm reconcile, then audit again), or the two records differ. A person should look.");
  }
  return lines;
}

/**
 * The audit, its exit code and its printed lines. The exit code and the verdict
 * lines are fixed before the narrator is called, and the narrator is handed a copy
 * of the report it can't write back to, so what a model says can only add lines
 * under its own heading.
 */
export async function runAudit(deps: AuditDeps, traceId: string, narrator: Narrator | null): Promise<{ readonly exitCode: number; readonly lines: readonly string[] }> {
  const report = await auditTrace(deps, traceId);
  const exitCode = exitCodeFor(report);
  const lines = renderReport(report);
  if (narrator === null || report.kind !== "AUDITED") return { exitCode, lines };
  let narration: readonly string[];
  try {
    narration = await narrator(structuredClone(report));
  } catch {
    narration = ["", "Narration unavailable: the narrator failed. The verdict above stands."];
  }
  return { exitCode, lines: [...lines, ...narration] };
}
