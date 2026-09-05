import { formatINR, paiseFromJSON, type ReasonCode } from "@praman/shared";
import { loadTrace } from "../data.js";
import { escapeHtml } from "../html.js";
import { layout } from "../layout.js";
import { REASON_CODE_PLAIN } from "../reason-codes.js";

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

  const reasonPlain = trace.reasonCode ? (REASON_CODE_PLAIN[trace.reasonCode as ReasonCode] ?? trace.reasonCode) : null;
  const amount = trace.amountPaise ? formatINR(paiseFromJSON(trace.amountPaise)) : null;

  const merchantReadsHtml = trace.merchantReads
    .map((r) => `<div class="untrusted">${escapeHtml(r)}</div>`)
    .join("\n");

  const entriesHtml = trace.entries
    .map(
      (e) => `<li class="entry">
        <span class="entry-type">${escapeHtml(e.eventType)}</span>
        <div class="entry-meta">seq ${e.seq.toString()} · entry_hash ${e.entryHash.slice(0, 12)}… · prev_hash ${e.prevHash.slice(0, 12)}…</div>
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
    ? `<section><h2>Goal given to the agent</h2><p class="goal">${escapeHtml(trace.goal)}</p></section>`
    : ""
}

${
  reasonPlain
    ? `<section class="reason">
         <p class="reason-plain">${escapeHtml(reasonPlain)}</p>
         <span class="reason-code data">${escapeHtml(trace.reasonCode ?? "")}</span>
       </section>`
    : ""
}

${
  trace.rationale
    ? `<section><h2>Agent's rationale</h2><p class="rationale">${escapeHtml(trace.rationale)}</p></section>`
    : ""
}

${
  merchantReadsHtml
    ? `<section><h2>Merchant content the agent read</h2>${merchantReadsHtml}</section>`
    : ""
}

<section>
  <h2>Ledger entries</h2>
  <ul class="entries">${entriesHtml}</ul>
</section>

<section>
  <p class="nav data">trace_id ${escapeHtml(traceId)}</p>
</section>
`;

  return { status: 200, html: layout(`Trace ${traceId}`, body) };
}
