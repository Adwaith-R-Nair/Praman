import { prisma } from "@praman/db";
import { verifyChain } from "@praman/ledger";
import { formatMoney, minorFromJSON } from "@praman/shared";
import { countTraces, listRecentTraceIds, loadTrace } from "../data.js";
import { decisionClass, decisionLabel } from "../decision-display.js";
import { escapeHtml, fixRupeeGlyph } from "../html.js";
import { layout } from "../layout.js";
import { classifyTrace } from "../verify.js";

const RECENT_LIMIT = 25;

/** Demo visitors' traces aren't listed here, so the index points to where they are. */
const DEMO_LINK = `<p class="index-demo-link"><a href="/demo">Walk through the demo story</a>, where each step links to its own trace.</p>`;

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
    // On the hosted server every trace is a demo visitor's, so this is what /traces shows there.
    return layout(
      "Recent traces",
      `<h1 class="decision"><a href="/demo">Start the demo</a></h1><p>There are no purchases outside the demo to list yet. In the demo an agent buys from sandbox merchants through PayPal, and each step links to its own trace.</p>`,
      "home",
    );
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
      const amount = trace.amountMinor ? formatMoney(minorFromJSON(trace.amountMinor), trace.currency) : "";
      const stateClass = verification.traceVerified ? "state-verified" : "state-broken";
      const stateLabel = verification.traceVerified ? "verified" : "broken";
      // The amount span is always rendered, even empty (a refused purchase
      // has none) — every row's meta block needs the same three grid
      // slots, or a missing one shifts everything after it left and the
      // decision/amount/state columns stop lining up across rows.
      return `<li class="trace-row">
        <a class="trace-row-link" href="/r/${escapeHtml(traceId)}">
          <span class="trace-row-summary">${fixRupeeGlyph(escapeHtml(summary))}</span>
          <span class="trace-row-meta">
            <span class="decision ${decisionClass(trace.decisionKind)}">${escapeHtml(decisionLabel(trace.decisionKind, trace.orderStatus))}</span>
            <span class="data">${amount}</span>
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

${DEMO_LINK}

<ul class="trace-list">${rowsHtml}</ul>

<script src="/assets/index.js" defer></script>
`;

  return layout("Recent traces", body, "home");
}
