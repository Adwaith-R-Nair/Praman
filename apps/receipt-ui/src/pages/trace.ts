import { publicPayload } from "@praman/dispute";
import { canonical, formatMoney, minorFromJSON, type ReasonCode } from "@praman/shared";
import type { EventType, LedgerEntryRecord } from "@praman/ledger";
import { loadTrace, type RefundLine, type SettlementLine, type TraceView } from "../data.js";
import { DEMO_MERCHANTS } from "../demo/config.js";
import { decisionClass, decisionLabel } from "../decision-display.js";
import { escapeHtml, fixRupeeGlyph } from "../html.js";
import { layout } from "../layout.js";
import { EVENT_TYPE_PLAIN, REASON_CODE_PLAIN } from "../reason-codes.js";
import { sampleMandateIds } from "../sample-config.js";
import { toolCallsHtml, toolCallsOf } from "./tool-calls.js";

/** Free text (goal, rationale, merchant content) may contain a literal ₹. */
function escFreeText(value: string): string {
  return fixRupeeGlyph(escapeHtml(value));
}

/**
 * LANGFUSE_PROJECT_ID is optional and separate from the API keys — it's the
 * id segment in the project's own dashboard URL, not something derivable
 * from a public/secret key pair. Without it we still have a real trace id,
 * just no deep link to build from it (every Langfuse project's URL path is
 * scoped to a project id, confirmed against the actual dashboard rather
 * than assumed).
 */
function langfuseTraceUrl(langfuseTraceId: string): string | null {
  const base = process.env["LANGFUSE_BASE_URL"];
  const projectId = process.env["LANGFUSE_PROJECT_ID"];
  if (!base || !projectId) return null;
  return `${base}/project/${projectId}/traces?peek=${langfuseTraceId}&traceId=${langfuseTraceId}`;
}

const RAIL_NAMES: Readonly<Record<string, string>> = { paypal: "PayPal", razorpay: "Razorpay" };
const SETTLEMENT_WORDS: Readonly<Record<string, string>> = { captured: "the capture completed", declined: "the capture was declined" };

/**
 * One line for what the provider reported by webhook. Every value is escaped even
 * though the parser only lets ids through: this page doesn't rely on that.
 */
function settlementHtml(settlement: SettlementLine | null): string {
  if (!settlement) return "";
  const rail = settlement.rail === null ? "The payment provider" : (RAIL_NAMES[settlement.rail] ?? settlement.rail);
  const what = settlement.status === null ? "a result" : (SETTLEMENT_WORDS[settlement.status] ?? settlement.status);
  const ids = [settlement.paymentId ? `payment ${settlement.paymentId}` : null, settlement.eventId ? `event ${settlement.eventId}` : null].filter((x) => x !== null);
  return `<section class="settlement">
    <h2>Settlement</h2>
    <p>${escapeHtml(`${rail} reported ${what}`)}, by a webhook whose signature was verified, at ${escapeHtml(settlement.at.toISOString())}.</p>
    ${ids.length > 0 ? `<p class="data">${escapeHtml(ids.join(" · "))}</p>` : ""}
  </section>`;
}

/**
 * How the money moved, in words, when the ledger shows it. A charge to a saved PayPal
 * account had nobody at PayPal, so the page says plainly whether anyone approved it.
 */
function paymentHtml(trace: { readonly payment: "saved_method" | "checkout" | null; readonly approvalVerdict: string | null; readonly approvedBy: "person" | "test_harness" | null; readonly orderStatus: string | null }): string {
  if (trace.payment === "saved_method") {
    const approval =
      trace.approvalVerdict !== "approve"
        ? "No person approved it. Praman's decision was the only check before the money moved."
        : trace.approvedBy === "test_harness"
          ? "The test harness approved it in Praman before the charge, not a person."
          : "A person approved it in Praman before the charge.";
    return `<section class="payment">
    <h2>How it was paid</h2>
    <p>Paid from the saved PayPal account, with no buyer present. PayPal took the money as it created the order, so there was no checkout page and no separate capture.</p>
    <p>${escapeHtml(approval)}</p>
  </section>`;
  }
  if (trace.payment === "checkout" && trace.orderStatus === "captured") {
    return `<section class="payment">
    <h2>How it was paid</h2>
    <p>Paid at PayPal's checkout. The buyer approved it at PayPal, then Praman checked the mandate again and captured it.</p>
  </section>`;
  }
  return "";
}

const REFUNDED_BY: Readonly<Record<string, string>> = {
  operator: "an operator, with pnpm refund",
  demo_visitor: "the demo visitor, on this trace page",
};

/**
 * The refund of this trace's payment, in words. Only a person can ask for one, and it
 * never gives the mandate's budget back (D-66, D-67), so the page says both.
 */
export function refundHtml(refund: RefundLine | null): string {
  if (refund === null) return "";
  const amount = refund.amountMinor !== null && /^\d+$/.test(refund.amountMinor) ? formatMoney(minorFromJSON(refund.amountMinor), refund.currency) : "the payment";
  const who = refund.requestedBy === null ? "a person" : (REFUNDED_BY[refund.requestedBy] ?? refund.requestedBy);
  let what: string;
  switch (refund.status) {
    case "refunded":
      what = `Refunded in full. ${amount} went back to the buyer.`;
      break;
    case "pending":
      what = `PayPal accepted the refund of ${amount} and hasn't finished it. The reconcile sweep records it when it does.`;
      break;
    case "requested":
      what = `A refund of ${amount} was asked for and has no answer yet. Praman won't send another; the reconcile sweep settles it.`;
      break;
    case "mismatch":
      what = `PayPal reported a refund of different money than Praman asked for${refund.railReported}. A person needs to look at it with PayPal.`;
      break;
    case "failed":
      what =
        refund.failureCode === "CAPTURE_FULLY_REFUNDED"
          ? "PayPal says this payment was already refunded in full, so this refund moved no money."
          : "PayPal refused the refund. No money went back, and it can be asked for again.";
      break;
  }
  const ids = [refund.refundId ? `refund ${refund.refundId}` : null, refund.failureCode ? `PayPal said ${refund.failureCode}` : null].filter((x) => x !== null);
  return `<section class="refund" id="refund">
    <h2>Refund</h2>
    <p>${escapeHtml(what)}</p>
    <p>${escapeHtml(`Asked for by ${who}, at ${refund.requestedAt.toISOString()}. An agent can't ask for a refund.`)}</p>
    <p>${escapeHtml("The mandate's budget still counts this purchase. A refund gives the money back to the buyer, not spending room back to the agent.")}</p>
    ${ids.length > 0 ? `<p class="data">${escapeHtml(ids.join(" · "))}</p>` : ""}
  </section>`;
}

/**
 * A revocation trace has no purchase. It says which mandate lost its authority, what
 * that does to every later purchase, and the issuer's reason, which a person typed.
 */
function revocationHtml(revocation: { readonly mandateId: string | null; readonly reason: string | null } | null): string {
  if (revocation === null) return "";
  const which = revocation.mandateId === null ? "a mandate" : `mandate ${revocation.mandateId}`;
  return `<section class="reason">
    <p class="reason-plain">${escapeHtml(`The issuer took back ${which}'s authority. Praman reads this row before every decision, so every purchase under it from here on is refused.`)}</p>
    <span class="reason-code data">MANDATE_REVOKED</span>
  </section>
  ${revocation.reason === null ? "" : `<section><h2>Reason the issuer gave</h2><p class="rationale">${escFreeText(revocation.reason)}</p></section>`}`;
}

/** An entry's plain name. A step-up the test harness resolved is never called a human review. */
function entryLabel(eventType: string, approvedBy: "person" | "test_harness" | null): string {
  if (eventType === "step_up_resolved" && approvedBy === "test_harness") return "Test harness approved the step-up. No person reviewed it";
  return EVENT_TYPE_PLAIN[eventType as EventType] ?? eventType;
}

/** A payload's canonical JSON goes into the page only up to this size. A larger one can be rehashed from the dispute bundle. */
export const MAX_PAYLOAD_CHARS_ON_PAGE = 100_000;

/**
 * What the browser needs to recompute this row's hashes itself (chain-verify.client.js),
 * as data attributes. The fields of the entry hash are sent as the exact text the ledger
 * hashed: seq in decimal and the time from toISOString(), as computeEntryHash() uses.
 *
 * The payload goes in only when the public copy holds all of it, as canonical JSON, so
 * its hash can be recomputed. A row with withheld fields (D-84) sends their names and no
 * payload: its payload hash can't be rehashed by the public, and the page says so. This
 * is what the public dispute bundle carries for the row, decided by the same function.
 */
function entryDataAttributes(e: LedgerEntryRecord): string {
  const pub = publicPayload(e.payload);
  let payloadText: string | null = null;
  if (pub.withheld.length === 0) {
    try {
      const text = canonical(pub.payload);
      if (text.length <= MAX_PAYLOAD_CHARS_ON_PAGE) payloadText = text;
    } catch {
      payloadText = null;
    }
  }
  return [
    `data-seq="${e.seq.toString()}"`,
    `data-ts="${escapeHtml(e.ts.toISOString())}"`,
    `data-actor="${escapeHtml(e.actor)}"`,
    `data-event-type="${escapeHtml(e.eventType)}"`,
    `data-payload-hash="${escapeHtml(e.payloadHash)}"`,
    `data-prev-hash="${escapeHtml(e.prevHash)}"`,
    `data-entry-hash="${escapeHtml(e.entryHash)}"`,
    `data-withheld="${escapeHtml(pub.withheld.join(","))}"`,
    ...(payloadText === null ? [] : [`data-payload="${escapeHtml(payloadText)}"`]),
  ].join(" ");
}

/**
 * `ownerControl` is for the demo's own view of a visitor's trace (/demo/r/<step>) only:
 * it renders what that visitor, and nobody else, may do with this trace, which is ask
 * for a refund. The public page at /r/<id> never has one.
 */
export async function renderTracePage(traceId: string, ownerControl: ((trace: TraceView) => string) | null = null, ownerBundleHref: string | null = null): Promise<{ status: number; html: string }> {
  const trace = await loadTrace(traceId);

  if (!trace) {
    return {
      status: 404,
      html: layout(
        "Not found",
        `<h1 class="decision">No such trace</h1>
         <p>There is no ledger record for <code>${escapeHtml(traceId)}</code>. Check the trace id and try again, or <a href="/demo">go to the demo</a>, where every step links to its own trace.</p>`,
        "home",
      ),
    };
  }

  // A demo visitor's revocation has no merchant, and its trace id says whose it is.
  const fromDemo = (trace.merchantId !== null && DEMO_MERCHANTS.includes(trace.merchantId)) || traceId.startsWith("trc_demo_");
  // A demo visitor's console shows only their own session; the whole-ledger console is local only.
  // A trace of the server's public sample opens in the sample's console, which anyone can read.
  // The owner's own page keeps the owner's console.
  const sampleIds = sampleMandateIds();
  const inSample = ownerControl === null && sampleIds.length > 0 && trace.entries.some((e) => typeof e.payload === "object" && e.payload !== null && "mandate_id" in e.payload && typeof e.payload.mandate_id === "string" && sampleIds.includes(e.payload.mandate_id));
  const consoleHref = `${inSample ? "/sample" : fromDemo ? "/demo/console" : "/console"}#trace=${encodeURIComponent(traceId)}`;

  // Suppressed for a plain OK: the hero already says "Allowed", and OK adds
  // no information beyond that — showing it anyway would be the page
  // repeating its own headline back to the reader.
  //
  // Only the owner's page names a step-up's reason: "threshold" says the amount crossed one,
  // and the agent's own view leaves that out (D-08, D-84).
  const reasonCode = ownerControl === null && trace.reasonCode !== null && trace.reasonCode.startsWith("STEP_UP_") ? null : trace.reasonCode;
  const reasonPlain =
    trace.refusalReason ??
    (reasonCode && reasonCode !== "OK" ? (REASON_CODE_PLAIN[reasonCode as ReasonCode] ?? reasonCode) : null);
  const amount = trace.amountMinor ? formatMoney(minorFromJSON(trace.amountMinor), trace.currency) : null;

  // One card per item, not one undifferentiated wall of text — the whole
  // point is that a reviewer can actually read each product on its own,
  // so an injected line sitting inside one description is something they
  // can notice, not something buried in a paragraph of six items at once.
  const merchantReadsHtml = trace.merchantReads
    .map(
      (item) => `<div class="merchant-item">
        <div class="merchant-item-header">
          <span class="merchant-item-title">${escFreeText(item.title)}</span>
          <span class="merchant-item-price data">${formatMoney(minorFromJSON(item.priceMinor), item.currency)}</span>
        </div>
        <div class="merchant-item-sku data">${escapeHtml(item.sku)}</div>
        <div class="untrusted">
          <span class="stamp">merchant data</span>
          <p class="untrusted-note">Treated as data, never as instructions.</p>
          <p class="untrusted-content">${escFreeText(item.description)}</p>
        </div>
      </div>`,
    )
    .join("\n");

  // Truncated to the same fixed prefix length on both sides of the join —
  // that consistency is what makes "same characters, same position" a
  // comparison the eye can actually do. Full value kept in data-full for
  // the print stylesheet (commit 9), where truncation stops being right.
  const hashRow = (label: string, value: string) =>
    `<div class="entry-hash"><span class="hash-label">${label}</span> <span class="hash-value" data-full="${escapeHtml(value)}">${escapeHtml(value.slice(0, 8))}…</span></div>`;

  const entriesHtml = trace.entries
    .map(
      (e, i) => `<li class="entry" ${entryDataAttributes(e)}>
        ${i > 0 ? hashRow("prev_hash", e.prevHash) : ""}
        <div class="entry-header">
          <span class="entry-type">${escapeHtml(entryLabel(e.eventType, trace.approvedBy))}</span>
          <span class="entry-seq">seq ${e.seq.toString()}</span>
        </div>
        ${hashRow("entry_hash", e.entryHash)}
      </li>`,
    )
    .join("\n");

  const body = `
<section class="hero ${decisionClass(trace.decisionKind)}">
  <div class="hero-top">
    <span id="verify-state" class="state state-unverified">not yet verified this session</span>
    <button id="verify-btn" type="button" data-trace-id="${escapeHtml(traceId)}">Verify this chain</button>
  </div>
  <h1 class="decision ${decisionClass(trace.decisionKind)}">${escapeHtml(decisionLabel(trace.decisionKind, trace.orderStatus))}</h1>
  ${amount ? `<div class="amount">${amount}</div>` : ""}
</section>

${trace.simulatedRail ? `<p class="notice" role="status">Simulated payment. This order went to the demo's simulated rail, so no payment provider was involved and no real or sandbox money moved. &quot;Payment provider called&quot; below means that simulated rail.</p>` : ""}

${
  trace.goal
    ? `<section><h2>Goal given to the agent</h2><p class="goal">${escFreeText(trace.goal)}</p></section>`
    : ""
}

${
  reasonPlain
    ? `<section class="reason">
         <p class="reason-plain">${escapeHtml(reasonPlain)}</p>
         ${reasonCode ? `<span class="reason-code data">${escapeHtml(reasonCode)}</span>` : ""}
         ${trace.railFailureCode ? `<span class="reason-code data">${escapeHtml(trace.railFailureCode)}</span>` : ""}
       </section>`
    : ""
}

${revocationHtml(trace.revocation)}

${paymentHtml(trace)}

${settlementHtml(trace.settlement)}

${refundHtml(trace.refund)}

${ownerControl === null ? "" : ownerControl(trace)}

${
  trace.rationale
    ? `<section><h2>Agent's rationale</h2>${
        trace.recordedModel === null
          ? ""
          : `<p class="reason-plain">${escapeHtml(`Recorded model answer, not live. The demo's daily model calls were used up, so this cart is a recorded answer from ${trace.recordedModel}, replayed. Praman priced and decided it live.`)}</p>`
      }<p class="rationale">${escFreeText(trace.rationale)}</p></section>`
    : ""
}

${toolCallsHtml(toolCallsOf(trace.entries))}

${
  merchantReadsHtml
    ? `<section><h2>Merchant content the agent read</h2>${merchantReadsHtml}</section>`
    : ""
}

<section>
  <h2>Ledger entries</h2>
  <div class="browser-verify" id="browser-verify" hidden>
    <p class="bv-lede">The button at the top asks this server to walk the whole ledger. This one asks nobody. Your browser rehashes the rows below itself, with WebCrypto, from the values already in this page.</p>
    <div class="bv-actions">
      <button type="button" id="bv-run">Verify in my browser</button>
      <label class="bv-toggle" for="bv-tamper"><input type="checkbox" id="bv-tamper" autocomplete="off"> Change one digit in my copy first</label>
    </div>
    <p class="bv-result" id="bv-result" role="status" aria-live="polite"></p>
    <p class="bv-note" id="bv-note"></p>
  </div>
  <ul class="spine">${entriesHtml}</ul>
</section>

${(() => {
  if (!trace.langfuseTraceId) return "";
  const url = langfuseTraceUrl(trace.langfuseTraceId);
  // Not evidence (D-47) — a debugging convenience shown as plain text when
  // LANGFUSE_PROJECT_ID isn't set, a link when it is, never anything more.
  const linkOrText = url
    ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(trace.langfuseTraceId)}</a>`
    : escapeHtml(trace.langfuseTraceId);
  return `<section><p class="nav data">debug trace (not evidence) ${linkOrText}</p></section>`;
})()}

<section>
  <p class="nav data">trace_id ${escapeHtml(traceId)}</p>
  <p class="nav">${ownerBundleHref === null ? `<a href="/dispute/${escapeHtml(traceId)}">Download dispute bundle</a>` : `<a href="${escapeHtml(ownerBundleHref)}">Download your dispute bundle, with the signed mandate</a>`}</p>
  <p class="nav"><a href="${escapeHtml(consoleHref)}">See this trace in the ledger console</a></p>
</section>

<script src="/assets/chain-verify.js" defer></script>
<script src="/assets/trace.js" defer></script>
`;


  return { status: 200, html: layout(`Trace ${traceId}`, body, inSample ? "sample" : fromDemo ? "demo" : "index") };
}
