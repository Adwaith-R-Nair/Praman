import { prisma } from "@praman/db";
import { verifyChain } from "@praman/ledger";
import { formatINR, paiseFromJSON } from "@praman/shared";
import { listRecentTraceIds, loadTrace } from "../data.js";
import { decisionClass, decisionLabel } from "../decision-display.js";
import { escapeHtml, fixRupeeGlyph } from "../html.js";
import { layout } from "../layout.js";
import { classifyTrace } from "../verify.js";

const RECENT_LIMIT = 25;

export async function renderIndexPage(): Promise<string> {
  const traceIds = await listRecentTraceIds(RECENT_LIMIT);

  if (traceIds.length === 0) {
    return layout("Recent traces", "<h1 class=\"decision\">No traces yet</h1><p>Run <code>pnpm demo</code> to create one.</p>");
  }

  // One global walk, reused for every row — verifyChain() checks the whole
  // ledger regardless of which trace asked, so running it once here and
  // classifying each listed trace against that single result is the same
  // answer N separate calls would give, for a fraction of the work.
  const chainResult = await prisma.$transaction((tx) => verifyChain(tx));

  const rows = await Promise.all(
    traceIds.map(async (traceId) => {
      const trace = await loadTrace(traceId);
      if (!trace) return null;
      const verification = classifyTrace(
        chainResult,
        trace.entries.map((e) => Number(e.seq)),
      );
      return { traceId, trace, verification };
    }),
  );

  const rowsHtml = rows
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .map(({ traceId, trace, verification }) => {
      const summary = trace.goal ?? trace.merchantId ?? traceId;
      const amount = trace.amountPaise ? formatINR(paiseFromJSON(trace.amountPaise)) : "";
      const stateClass = verification.traceVerified ? "state-verified" : "state-broken";
      const stateLabel = verification.traceVerified ? "verified" : "broken";
      return `<li class="trace-row">
        <a class="trace-row-link" href="/r/${escapeHtml(traceId)}">
          <span class="trace-row-summary">${fixRupeeGlyph(escapeHtml(summary))}</span>
          <span class="trace-row-meta">
            <span class="decision ${decisionClass(trace.decisionKind)}">${escapeHtml(decisionLabel(trace.decisionKind, trace.orderStatus))}</span>
            ${amount ? `<span class="data">${amount}</span>` : ""}
            <span class="state ${stateClass}">${stateLabel}</span>
          </span>
        </a>
      </li>`;
    })
    .join("\n");

  const body = `
<h1 class="decision">Recent traces</h1>
<ul class="trace-list">${rowsHtml}</ul>
`;

  return layout("Recent traces", body);
}
