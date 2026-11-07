import { formatMoney, minorFromJSON, type ReasonCode } from "@praman/shared";
import type { EventType } from "@praman/ledger";
import { loadTrace, type SettlementLine } from "../data.js";
import { DEMO_MERCHANTS } from "../demo/config.js";
import { decisionClass, decisionLabel } from "../decision-display.js";
import { escapeHtml, fixRupeeGlyph } from "../html.js";
import { layout } from "../layout.js";
import { EVENT_TYPE_PLAIN, REASON_CODE_PLAIN } from "../reason-codes.js";

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

/** An entry's plain name. A step-up the test harness resolved is never called a human review. */
function entryLabel(eventType: string, approvedBy: "person" | "test_harness" | null): string {
  if (eventType === "step_up_resolved" && approvedBy === "test_harness") return "Test harness approved the step-up. No person reviewed it";
  return EVENT_TYPE_PLAIN[eventType as EventType] ?? eventType;
}

export async function renderTracePage(traceId: string): Promise<{ status: number; html: string }> {
  const trace = await loadTrace(traceId);

  if (!trace) {
    return {
      status: 404,
      html: layout(
        "Not found",
        `<h1 class="decision">No such trace</h1>
         <p>There is no ledger record for <code>${escapeHtml(traceId)}</code>. Check the trace id and try again.</p>`,
      ),
    };
  }

  // Suppressed for a plain OK: the hero already says "Allowed", and OK adds
  // no information beyond that — showing it anyway would be the page
  // repeating its own headline back to the reader.
  const reasonPlain =
    trace.refusalReason ??
    (trace.reasonCode && trace.reasonCode !== "OK" ? (REASON_CODE_PLAIN[trace.reasonCode as ReasonCode] ?? trace.reasonCode) : null);
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
      (e, i) => `<li class="entry" data-seq="${e.seq.toString()}">
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

${
  trace.goal
    ? `<section><h2>Goal given to the agent</h2><p class="goal">${escFreeText(trace.goal)}</p></section>`
    : ""
}

${
  reasonPlain
    ? `<section class="reason">
         <p class="reason-plain">${escapeHtml(reasonPlain)}</p>
         ${trace.reasonCode ? `<span class="reason-code data">${escapeHtml(trace.reasonCode)}</span>` : ""}
         ${trace.railFailureCode ? `<span class="reason-code data">${escapeHtml(trace.railFailureCode)}</span>` : ""}
       </section>`
    : ""
}

${paymentHtml(trace)}

${settlementHtml(trace.settlement)}

${
  trace.rationale
    ? `<section><h2>Agent's rationale</h2>${
        trace.recordedModel === null
          ? ""
          : `<p class="reason-plain">${escapeHtml(`Recorded model answer, not live. The demo's daily model calls were used up, so this cart is a recorded answer from ${trace.recordedModel}, replayed. Praman priced and decided it live.`)}</p>`
      }<p class="rationale">${escFreeText(trace.rationale)}</p></section>`
    : ""
}

${
  merchantReadsHtml
    ? `<section><h2>Merchant content the agent read</h2>${merchantReadsHtml}</section>`
    : ""
}

<section>
  <h2>Ledger entries</h2>
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
  <p class="nav"><a href="/dispute/${escapeHtml(traceId)}">Download dispute bundle</a></p>
</section>

<script src="/assets/trace.js" defer></script>
`;

  const fromDemo = trace.merchantId !== null && DEMO_MERCHANTS.includes(trace.merchantId);
  return { status: 200, html: layout(`Trace ${traceId}`, body, fromDemo ? "demo" : "index") };
}
