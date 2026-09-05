import { formatINR, paiseFromJSON, type ReasonCode } from "@praman/shared";
import type { EventType } from "@praman/ledger";
import { loadTrace } from "../data.js";
import { escapeHtml, fixRupeeGlyph } from "../html.js";
import { layout } from "../layout.js";
import { EVENT_TYPE_PLAIN, REASON_CODE_PLAIN } from "../reason-codes.js";

/** Free text (goal, rationale, merchant content) may contain a literal ₹. */
function escFreeText(value: string): string {
  return fixRupeeGlyph(escapeHtml(value));
}

function decisionClass(kind: string | null): string {
  if (kind === "ALLOW") return "decision-allow";
  if (kind === "STEP_UP") return "decision-step-up";
  if (kind === "DENY") return "decision-deny";
  return "";
}

function decisionLabel(kind: string | null, orderStatus: string | null): string {
  if (kind === "ALLOW" && orderStatus) return `Allowed — ${orderStatus}`;
  if (kind === "ALLOW") return "Allowed";
  if (kind === "STEP_UP") return "Needs approval";
  if (kind === "DENY") return "Refused";
  return "Unknown";
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
  const amount = trace.amountPaise ? formatINR(paiseFromJSON(trace.amountPaise)) : null;

  const merchantReadsHtml = trace.merchantReads
    .map((r) => `<div class="untrusted">${escFreeText(r)}</div>`)
    .join("\n");

  // Truncated to the same fixed prefix length on both sides of the join —
  // that consistency is what makes "same characters, same position" a
  // comparison the eye can actually do. Full value kept in data-full for
  // the print stylesheet (commit 9), where truncation stops being right.
  const hashRow = (label: string, value: string) =>
    `<div class="entry-hash"><span class="hash-label">${label}</span> <span class="hash-value" data-full="${escapeHtml(value)}">${escapeHtml(value.slice(0, 8))}…</span></div>`;

  const entriesHtml = trace.entries
    .map(
      (e, i) => `<li class="entry">
        ${i > 0 ? hashRow("prev_hash", e.prevHash) : ""}
        <div class="entry-header">
          <span class="entry-type">${escapeHtml(EVENT_TYPE_PLAIN[e.eventType as EventType] ?? e.eventType)}</span>
          <span class="entry-seq">seq ${e.seq.toString()}</span>
        </div>
        ${hashRow("entry_hash", e.entryHash)}
      </li>`,
    )
    .join("\n");

  const body = `
<section class="hero">
  <span class="state state-unverified">not yet verified this session</span>
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
       </section>`
    : ""
}

${
  trace.rationale
    ? `<section><h2>Agent's rationale</h2><p class="rationale">${escFreeText(trace.rationale)}</p></section>`
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

<section>
  <p class="nav data">trace_id ${escapeHtml(traceId)}</p>
</section>
`;

  return { status: 200, html: layout(`Trace ${traceId}`, body) };
}
