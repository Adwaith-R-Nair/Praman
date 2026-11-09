import { formatMoney, minorFromJSON } from "@praman/shared";
import { loadPublicConsoleData, type ConsoleData } from "../console/data.js";
import { renderConsolePage, type ConsolePage, type SampleTraceLink } from "../console/page.js";
import { loadTrace } from "../data.js";
import { decisionClass, decisionLabel } from "../decision-display.js";
import { layout } from "../layout.js";

/**
 * The public sample at /sample: one past session's ledger rows in the console, and a
 * link to each of its traces and public dispute bundles. Which session is server
 * configuration (sample-config.ts); no request chooses it.
 *
 * It is built only from what anyone holding a trace id can already read: the rows come
 * through loadPublicConsoleData, which drops budgets and step-up reasons (D-84), and
 * each trace's line is the public trace page's own headline, goal and amount.
 */
export interface SampleView {
  readonly data: ConsoleData;
  readonly traces: readonly SampleTraceLink[];
}

/** No sample is longer than this many traces on the page. The grid still holds every row. */
export const MAX_SAMPLE_TRACES = 60;

export async function loadSample(mandateIds: readonly string[], now: Date): Promise<SampleView> {
  const data = await loadPublicConsoleData(mandateIds, now);
  // In the order they happened: rows arrive by seq, so a trace's first row places it.
  const traceIds = [...new Set(data.rows.map((r) => r.traceId))].slice(0, MAX_SAMPLE_TRACES);
  const loaded = await Promise.all(traceIds.map((traceId) => loadTrace(traceId)));
  const traces: SampleTraceLink[] = [];
  for (const trace of loaded) {
    if (trace === null) continue;
    traces.push({
      traceId: trace.traceId,
      summary: trace.goal ?? trace.merchantId ?? trace.traceId,
      label: decisionLabel(trace.decisionKind, trace.orderStatus),
      labelClass: decisionClass(trace.decisionKind),
      amount: trace.amountMinor !== null && /^\d+$/.test(trace.amountMinor) ? formatMoney(minorFromJSON(trace.amountMinor), trace.currency) : null,
    });
  }
  return { data, traces };
}

/** How long one load of the sample is shared. */
export const SAMPLE_CACHE_MS = 60_000;

/**
 * Loads the sample at most once a minute, however many people open it. The sample is a
 * fixed session and each load walks the whole chain, so a burst of readers shares one
 * walk. A failed load is not kept. `generatedAt` in the data says when the walk ran.
 */
export function createSampleLoader(now: () => Date, load: typeof loadSample = loadSample): (mandateIds: readonly string[]) => Promise<SampleView> {
  let cached: { readonly key: string; readonly at: number; readonly view: Promise<SampleView> } | null = null;
  return (mandateIds) => {
    const key = mandateIds.join(",");
    const at = now().getTime();
    if (cached !== null && cached.key === key && at - cached.at < SAMPLE_CACHE_MS) return cached.view;
    const view = load(mandateIds, now());
    const entry = { key, at, view };
    cached = entry;
    view.catch(() => {
      if (cached === entry) cached = null;
    });
    return view;
  };
}

export function renderSamplePage(traces: readonly SampleTraceLink[], nonce: string): ConsolePage {
  return renderConsolePage("sample", nonce, null, traces);
}

/** What /sample says on a server with no sample set. Nothing links here in that case. */
export function renderNoSamplePage(): string {
  return layout(
    "No sample run",
    `<h1 class="decision">No sample run on this server</h1>
     <p>This server has no past session set as its public sample, so there is nothing to show here. <a href="/demo">Go to the demo</a> to run the story yourself, or <a href="/">read what Praman is</a>.</p>`,
    "home",
  );
}
