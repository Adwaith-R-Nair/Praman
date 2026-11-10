/**
 * The owner's "In AP2 terms" view of a signed mandate (D-94). Display only: it reads a
 * document whose signature the caller has already checked, and it decides nothing.
 *
 * Every AP2 name below is copied from docs/PROTOCOLS.md (AP2 v0.2, read 9 Nov 2026) or
 * from the IntentMandate class in AP2's own repository at tag v0.1.0
 * (src/ap2/types/mandate.py, read 10 Nov 2026). Praman implements neither version.
 *
 * It carries the mandate's limits, which the public bundle withholds (D-84), so only
 * the owner's bundle may hold it.
 */

export const AP2_LABEL = "In AP2 terms (a mapping, not an AP2 mandate)";

/** "direct": same rule, another name. "loose": nearest concept, with a real difference. "none": no place for it. "gap": AP2 needs something Praman lacks. */
export type Ap2Fit = "direct" | "loose" | "none" | "gap";

export interface Ap2Row {
  /** The field's name inside the signed document, as that version spells it. */
  readonly praman_field: string;
  /** The signed value as written, or null when the field sits beside the document. */
  readonly praman_value: string | readonly string[] | null;
  /** The AP2 v0.1 counterpart, or null if there is none. */
  readonly ap2_v0_1: string | null;
  /** The AP2 v0.2 counterpart, or null if there is none. */
  readonly ap2_v0_2: string | null;
  readonly fit: Ap2Fit;
  readonly note: string;
}

export interface Ap2View {
  readonly label: typeof AP2_LABEL;
  readonly note: string;
  readonly praman_version: 1 | 2;
  readonly fields: readonly Ap2Row[];
  /** AP2 fields that Praman's mandate has no value for. Left empty, never filled in. */
  readonly ap2_with_no_praman_value: readonly { readonly ap2: string; readonly note: string }[];
  /** Section 4 of docs/PROTOCOLS.md, one line each. */
  readonly gaps: readonly string[];
}

const NOTE =
  "Praman's mandate placed beside AP2's field names, for reading only. Praman implements neither AP2 v0.1 nor v0.2, is not compliant with either, and nothing here was run against an AP2 verifier. AP2 names are from AP2 v0.1 (IntentMandate) and v0.2 (open Payment and Checkout Mandates). See docs/PROTOCOLS.md.";

const GAPS: readonly string[] = [
  "No verifiable-credential format. A Praman mandate is canonical JSON with an Ed25519 signature. AP2 mandates are SD-JWTs with selective disclosure.",
  "No agent key binding. subject_id is a name inside the signed document. There is no cnf claim and the agent holds no key.",
  "No user-held key and no trusted signing surface. The hosted demo signs each visitor's mandate with a demo key.",
  "No merchant-signed cart. The price comes from Praman's own copy of the catalog. There is no checkout_jwt.",
  "Decisions are not signed receipts. A decision is a hash-chained ledger row, not a JWT a verifier signed.",
  "No network tokens and no Payment Mandate. Nothing is sent to an issuer or a card network.",
  "Four limits have no standard constraint: category scope, the velocity window, the denial-rate cap and the step-up threshold.",
  "Amounts. Praman uses integer minor units. The AP2 constraint examples read on 9 Nov use decimals such as 100.50.",
  "No interop test, and sandbox only. No PayPal-hosted AP2 endpoint was found to test against.",
];

const NO_PRAMAN_VALUE: Ap2View["ap2_with_no_praman_value"] = [
  { ap2: "IntentMandate.natural_language_description", note: "Praman signs no description of the user's intent. The agent's goal is in the trace, not in the mandate." },
  { ap2: "IntentMandate.skus", note: "Praman signs categories, not SKUs. The agent names a SKU per purchase and the catalog prices it." },
  { ap2: "IntentMandate.requires_refundability", note: "Praman's mandate has no refundability field." },
  { ap2: "closed Checkout Mandate (Cart Mandate in v0.1), checkout_jwt", note: "There is no merchant-signed cart." },
  { ap2: "closed Payment Mandate (Payment Mandate in v0.1)", note: "Nothing is sent to a card network or an issuer." },
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function digits(v: unknown): string | null {
  return typeof v === "string" && /^\d+$/.test(v) ? v : null;
}

function count(v: unknown): string | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v.toString() : null;
}

function strings(v: unknown): readonly string[] | null {
  return Array.isArray(v) && v.every((x): x is string => typeof x === "string") ? v : null;
}

interface Read {
  version: 1 | 2;
  unit: "paise" | "minor";
  mandateId: string;
  issuer: string;
  subject: string;
  merchants: readonly string[];
  categories: readonly string[];
  currency: string;
  maxPerTxn: string;
  maxTotal: string;
  threshold: string;
  maxTxns: string;
  windowSeconds: string;
  maxDenials: string;
  notBefore: string;
  notAfter: string;
  nonce: string;
}

/** Reads the document the way its version spells it. Anything missing or misnamed is null, never a guess. */
function readDocument(d: unknown): Read | null {
  if (!isRecord(d)) return null;
  const { version, scope, limits, step_up: stepUp, validity } = d;
  if ((version !== 1 && version !== 2) || !isRecord(scope) || !isRecord(limits) || !isRecord(stepUp) || !isRecord(validity)) return null;
  const unit = version === 1 ? "paise" : "minor";
  const currency = str(scope["currency"]);
  if (version === 1 && currency !== "INR") return null;
  const read = {
    mandateId: str(d["mandate_id"]),
    issuer: str(d["issuer_id"]),
    subject: str(d["subject_id"]),
    merchants: strings(scope["merchant_ids"]),
    categories: strings(scope["categories"]),
    currency,
    maxPerTxn: digits(limits[`max_per_txn_${unit}`]),
    maxTotal: digits(limits[`max_total_${unit}`]),
    threshold: digits(stepUp[`threshold_${unit}`]),
    maxTxns: count(limits["max_txns_per_window"]),
    windowSeconds: count(limits["window_seconds"]),
    maxDenials: count(limits["max_denials_per_window"]),
    notBefore: str(validity["not_before"]),
    notAfter: str(validity["not_after"]),
    nonce: str(d["nonce"]),
  };
  const {
    mandateId, issuer, subject, merchants, categories, maxPerTxn, maxTotal, threshold, maxTxns, windowSeconds, maxDenials, notBefore, notAfter, nonce,
  } = read;
  if (
    mandateId === null || issuer === null || subject === null || merchants === null || categories === null || currency === null ||
    maxPerTxn === null || maxTotal === null || threshold === null || maxTxns === null || windowSeconds === null || maxDenials === null ||
    notBefore === null || notAfter === null || nonce === null
  ) {
    return null;
  }
  return { version, unit, mandateId, issuer, subject, merchants, categories, currency, maxPerTxn, maxTotal, threshold, maxTxns, windowSeconds, maxDenials, notBefore, notAfter, nonce };
}

/**
 * The view for a mandate document whose signature already held. Null when the document
 * isn't a v1 or v2 mandate this code can read in full.
 */
export function inAp2Terms(document: unknown): Ap2View | null {
  const m = readDocument(document);
  if (m === null) return null;
  const u = m.unit;
  const fields: Ap2Row[] = [
    { praman_field: "mandate_id", praman_value: m.mandateId, ap2_v0_1: null, ap2_v0_2: null, fit: "loose", note: "AP2 v0.2 has no id field. A receipt points at a mandate by a hash of it (reference)." },
    { praman_field: "version", praman_value: m.version.toString(), ap2_v0_1: null, ap2_v0_2: "vct", fit: "direct", note: "AP2 names the type and version in vct, such as mandate.payment.open.1." },
    { praman_field: "issuer_id", praman_value: m.issuer, ap2_v0_1: null, ap2_v0_2: null, fit: "loose", note: "In AP2 the user signs on a Trusted Surface. There is no issuer field." },
    { praman_field: "subject_id", praman_value: m.subject, ap2_v0_1: null, ap2_v0_2: "cnf", fit: "gap", note: "AP2's cnf is the agent's public key. Praman's subject_id is a signed label that nothing checks against the caller." },
    { praman_field: "scope.merchant_ids", praman_value: m.merchants, ap2_v0_1: "IntentMandate.merchants", ap2_v0_2: "payment.allowed_payees, checkout.allowed_merchants", fit: "direct", note: "A closed allowlist of merchants." },
    { praman_field: "scope.categories", praman_value: m.categories, ap2_v0_1: null, ap2_v0_2: null, fit: "none", note: "No standard constraint. The nearest, checkout.line_items, lists acceptable item ids, not categories." },
    { praman_field: "scope.currency", praman_value: m.currency, ap2_v0_1: null, ap2_v0_2: "currency on payment.amount_range and payment.budget", fit: "direct", note: "The only source of currency. Nothing is converted." },
    { praman_field: `limits.max_per_txn_${u}`, praman_value: m.maxPerTxn, ap2_v0_1: null, ap2_v0_2: "payment.amount_range, field max", fit: "direct", note: "Cap on one purchase, in integer minor units." },
    { praman_field: `limits.max_total_${u}`, praman_value: m.maxTotal, ap2_v0_1: null, ap2_v0_2: "payment.budget, field max", fit: "direct", note: "Cap on all purchases under the mandate, in integer minor units." },
    { praman_field: "limits.max_txns_per_window", praman_value: m.maxTxns, ap2_v0_1: null, ap2_v0_2: "payment.agent_recurrence (frequency, max_occurrences)", fit: "loose", note: "AP2's is a schedule, not a rate limit." },
    { praman_field: "limits.window_seconds", praman_value: m.windowSeconds, ap2_v0_1: null, ap2_v0_2: "payment.agent_recurrence (frequency, max_occurrences)", fit: "loose", note: "AP2's is a schedule, not a rate limit." },
    { praman_field: "limits.max_denials_per_window", praman_value: m.maxDenials, ap2_v0_1: null, ap2_v0_2: null, fit: "none", note: "A Praman addition: the mandate locks after too many refusals." },
    { praman_field: `step_up.threshold_${u}`, praman_value: m.threshold, ap2_v0_1: "IntentMandate.user_cart_confirmation_required", ap2_v0_2: null, fit: "loose", note: "AP2 v0.1's field is one yes or no for the whole mandate. Praman asks a person at or above this amount and at a new merchant. AP2 v0.2 has no constraint type for it." },
    { praman_field: "validity.not_before", praman_value: m.notBefore, ap2_v0_1: null, ap2_v0_2: "payment.execution_date, field not_before", fit: "direct", note: "The mandate works only after this time." },
    { praman_field: "validity.not_after", praman_value: m.notAfter, ap2_v0_1: "IntentMandate.intent_expiry", ap2_v0_2: "payment.execution_date, field not_after", fit: "direct", note: "The mandate works only before this time." },
    { praman_field: "nonce", praman_value: m.nonce, ap2_v0_1: null, ap2_v0_2: "nonce on a closed mandate", fit: "loose", note: "AP2's closed mandate examples carry a nonce in the part the agent signs." },
    { praman_field: "signature", praman_value: null, ap2_v0_1: null, ap2_v0_2: "SD-JWT signed by the user's key", fit: "gap", note: "Praman's is Ed25519 over the canonical JSON, beside the document, not an SD-JWT." },
  ];
  return { label: AP2_LABEL, note: NOTE, praman_version: m.version, fields, ap2_with_no_praman_value: NO_PRAMAN_VALUE, gaps: GAPS };
}

function counterpart(r: Ap2Row): string {
  const parts = [r.ap2_v0_1 === null ? null : `v0.1 ${r.ap2_v0_1}`, r.ap2_v0_2 === null ? null : `v0.2 ${r.ap2_v0_2}`].filter((p) => p !== null);
  return parts.length === 0 ? "no AP2 counterpart" : parts.join("; ");
}

function shown(v: Ap2Row["praman_value"]): string {
  if (v === null) return "(beside the document)";
  return typeof v === "string" ? v : v.join(", ");
}

/** The operator's terminal lines for `pnpm dispute`. */
export function ap2Lines(view: Ap2View | null): string[] {
  if (view === null) return ["In AP2 terms: not shown, because this trace has no verified signed mandate"];
  return [
    view.label,
    ...view.fields.map((r) => `  ${r.praman_field} = ${shown(r.praman_value)}  ->  ${counterpart(r)}  [${r.fit}]`),
    `  AP2 fields with no Praman value: ${view.ap2_with_no_praman_value.map((r) => r.ap2).join("; ")}`,
    `  gaps: ${view.gaps.length.toString()}, listed in the bundle under in_ap2_terms.gaps and in docs/PROTOCOLS.md section 4`,
  ];
}
