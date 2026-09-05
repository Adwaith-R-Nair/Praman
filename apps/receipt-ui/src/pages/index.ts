import { prisma } from "@praman/db";
import { verifyChain } from "@praman/ledger";
import { formatINR, paiseFromJSON } from "@praman/shared";
import { countTraces, listRecentTraceIds, loadTrace } from "../data.js";
import { decisionClass, decisionLabel } from "../decision-display.js";
import { escapeHtml, fixRupeeGlyph } from "../html.js";
import { layout } from "../layout.js";
import { classifyTrace } from "../verify.js";

const RECENT_LIMIT = 25;

/** The masthead's chain-status line, in plain language, off the same VerifyResult every row is already classified against. */
function chainSummary(chainResult: Awaited<ReturnType<typeof verifyChain>>): { label: string; detail: string; ok: boolean } {
  if (chainResult.ok) {
    return { label: "chain intact", detail: `${chainResult.checked.toString()} ledger entries verified`, ok: true };
  }
  return { label: "chain broken", detail: `stopped at seq ${chainResult.brokenAt.toString()}`, ok: false };
}

export async function renderIndexPage(): Promise<string> {
  const traceIds = await listRecentTraceIds(RECENT_LIMIT);

  if (traceIds.length === 0) {
    return layout("Recent traces", "<h1 class=\"decision\">No traces yet</h1><p>Run <code>pnpm demo</code> to create one.</p>");
  }

  // One global walk, reused for every row — verifyChain() checks the whole
  // ledger regardless of which trace asked, so running it once here and
  // classifying each listed trace against that single result is the same
  // answer N separate calls would give, for a fraction of the work.
  const [chainResult, totalTraces] = await Promise.all([prisma.$transaction((tx) => verifyChain(tx)), countTraces()]);
  const chain = chainSummary(chainResult);

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
<header class="masthead">
  <div class="masthead-count">
    <span class="masthead-number" data-count-to="${totalTraces.toString()}">0</span>
    <span class="masthead-label">traces recorded</span>
  </div>
  <div class="masthead-chain">
    <span class="state ${chain.ok ? "state-verified" : "state-broken"}">${escapeHtml(chain.label)}</span>
    <span class="masthead-chain-detail data">${escapeHtml(chain.detail)}</span>
  </div>
</header>

<ul class="trace-list">${rowsHtml}</ul>

<script>
(function () {
  var el = document.querySelector(".masthead-number");
  if (!el) return;
  var target = Number(el.getAttribute("data-count-to"));
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced || target === 0) {
    el.textContent = String(target);
    return;
  }
  var DURATION_MS = 700;
  var start = null;
  function tick(ts) {
    if (start === null) start = ts;
    var progress = Math.min((ts - start) / DURATION_MS, 1);
    el.textContent = String(Math.round(progress * target));
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
</script>
`;

  return layout("Recent traces", body);
}
