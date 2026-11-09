import { randomBytes } from "node:crypto";
import { VENDOR, vendorPath } from "../assets.js";
import { consolePolicy } from "../csp.js";
import { escapeHtml } from "../html.js";
import { sampleConfigured } from "../sample-config.js";

/**
 * Who is looking: a demo visitor at their own session, a local operator at the whole
 * ledger, or anyone at the one past session the server pins as its public sample.
 */
export type ConsoleMode = "visitor" | "operator" | "sample";

/** One trace of the sample, for the list of links under the grid. Every field is shown as escaped text. */
export interface SampleTraceLink {
  readonly traceId: string;
  /** The goal the agent was given, or the merchant, or the trace id. */
  readonly summary: string;
  /** The trace page's own headline: Allowed, Needs approval, Refused... */
  readonly label: string;
  readonly labelClass: string;
  readonly amount: string | null;
}

export interface ConsolePage {
  readonly html: string;
  /** The Content-Security-Policy for this response only. Its style nonce is new each time. */
  readonly policy: string;
}

/** A fresh nonce for one console response. 18 random bytes, base64. */
export function newStyleNonce(): string {
  return randomBytes(18).toString("base64");
}

const COPY: Readonly<Record<ConsoleMode, { readonly back: string; readonly backLabel: string; readonly kicker: string; readonly title: string; readonly lede: string; readonly data: string }>> = {
  visitor: {
    back: "/demo",
    backLabel: "← back to the demo",
    kicker: "Ledger console",
    title: "Your session on the ledger",
    lede: "Every ledger row this session's two mandates produced: the story's mandate and the separate one the twenty-at-once test spends. Each row's hashes are recomputed on the server, and the whole chain is walked from its first row. Nobody else's rows are here, and yours are not in anyone else's console.",
    data: "/demo/console/data",
  },
  operator: {
    back: "/traces",
    backLabel: "← all traces",
    kicker: "Ledger console",
    title: "Operator console",
    lede: "The newest rows of the whole ledger, every mandate and every rail. This view exists only on a server with the demo turned off, which in practice means your own machine.",
    data: "/console/data",
  },
  sample: {
    back: "/",
    backLabel: "← Praman",
    kicker: "Sample run",
    title: "One past session, on the ledger",
    lede: "A session that already ran on this server, picked in the server's configuration and shown read-only. These are the ledger rows it wrote, not a recording: the server recomputes each row's hashes and walks the whole chain from its first row, and readers share one such check for up to a minute. You see what a public trace page and a public dispute bundle show. The mandate's limits, its signature and the reason behind each request for approval are withheld.",
    data: "/sample/data",
  },
};

/** Where a visitor with no session can still see a populated console. Only offered when the server has a sample. */
const SAMPLE_LINK = `<p class="notice-more"><a href="/sample">See a sample run</a>: a past session's rows, read-only, with nothing to start.</p>`;

function sampleTracesHtml(traces: readonly SampleTraceLink[]): string {
  if (traces.length === 0) return "";
  const items = traces
    .map((t) => {
      const id = encodeURIComponent(t.traceId);
      return `<li class="sample-trace">
      <a class="sample-trace-main" href="/r/${id}"><span class="sample-trace-summary">${escapeHtml(t.summary)}</span> <span class="sample-trace-label ${escapeHtml(t.labelClass)}">${escapeHtml(t.label)}</span>${t.amount === null ? "" : ` <span class="sample-trace-amount">${escapeHtml(t.amount)}</span>`}</a>
      <span class="sample-trace-id">${escapeHtml(t.traceId)}</span>
      <a class="sample-trace-bundle" href="/dispute/${id}" aria-label="${escapeHtml(`Public dispute bundle for ${t.traceId}`)}">public dispute bundle</a>
    </li>`;
    })
    .join("\n");
  return `<section class="sample-traces" aria-labelledby="sample-traces-title">
  <h2 id="sample-traces-title">Traces in this sample</h2>
  <p class="card-note">Each purchase, refusal or revocation is one trace. Its page shows what the agent read and did, and its bundle is the public record a dispute would start from.</p>
  <ol class="sample-trace-list">${items}</ol>
</section>`;
}

/**
 * The console's page. It carries no ledger data: the script fetches it from the data
 * route, as JSON, and every value goes into the page as text. The page itself is a
 * fixed frame, so the only thing that changes per response is the style nonce. The
 * sample page adds one thing, a list of links to its traces, escaped here, so the
 * links work with no script.
 */
export function renderConsolePage(mode: ConsoleMode, nonce: string, notice: string | null = null, sampleTraces: readonly SampleTraceLink[] = []): ConsolePage {
  const copy = COPY[mode];
  // A visitor with no session has an empty console. If this server has a sample, say where one with rows is.
  const more = mode === "visitor" && notice !== null && sampleConfigured() ? SAMPLE_LINK : "";
  const n = escapeHtml(nonce);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(copy.title)} · Praman</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=PT+Serif:ital,wght@0,400;0,700;1,400&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/console.css">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
</head>
<body>
<main class="console" id="console" data-mode="${escapeHtml(mode)}" data-src="${notice === null ? escapeHtml(copy.data) : ""}">
<nav class="nav"><a href="${escapeHtml(copy.back)}">${escapeHtml(copy.backLabel)}</a></nav>
<header class="masthead">
  <p class="kicker">${escapeHtml(copy.kicker)}</p>
  <h1>${escapeHtml(copy.title)}</h1>
  <p class="lede">${escapeHtml(copy.lede)}</p>
</header>
${notice === null ? "" : `<p class="notice" role="status">${escapeHtml(notice)}</p>`}${more}
<section class="chain" id="chain" role="status" aria-live="polite" data-state="loading">
  <span class="chain-stamp" id="chain-stamp">Checking</span>
  <p class="chain-text" id="chain-text">Walking the hash chain from its first row.</p>
</section>
<div class="chain-browser" id="chain-browser" hidden>
  <button type="button" id="chain-browser-run" class="btn-quiet">Recheck these rows in my browser</button>
  <p class="chain-browser-text" id="chain-browser-text" role="status" aria-live="polite">The verdict above is the server's. This asks nobody: your browser recomputes each row's entry hash itself.</p>
</div>
<section class="tiles" id="tiles" aria-label="Totals"></section>
<section class="charts" aria-label="Charts">
  <figure class="card card-wide">
    <figcaption>
      <h2>Spend against budget</h2>
      <p class="card-note" id="spend-note">Spent or held under one mandate, row by row. The line ends at the number Praman's policy reads.</p>
      <label class="select-label" for="spend-mandate">Mandate</label>
      <select id="spend-mandate"></select>
    </figcaption>
    <div class="chart" id="chart-spend" role="img" aria-label="Spend against budget over time"></div>
  </figure>
  <figure class="card">
    <figcaption>
      <h2>Decisions by reason code</h2>
      <p class="card-note">${mode === "sample" ? "Every decision and capture re-check that names its reason. A request for approval isn't drawn, because its reason is withheld here. Select a bar to filter the ledger below to that code." : "Every decision and capture re-check. Select a bar to filter the ledger below to that code."}</p>
    </figcaption>
    <div class="chart" id="chart-reasons" role="img" aria-label="Decisions by reason code"></div>
  </figure>
  <figure class="card">
    <figcaption>
      <h2>Outcomes by rail</h2>
      <p class="card-note">Each order once, at its latest outcome. Select a bar to filter the ledger to that rail.</p>
    </figcaption>
    <div class="chart" id="chart-rails" role="img" aria-label="Outcomes by rail"></div>
  </figure>
</section>
<section class="ledger" aria-labelledby="ledger-title">
  <div class="ledger-head">
    <h2 id="ledger-title">Ledger rows</h2>
    <div class="toolbar">
      <label for="quick">Search every column</label>
      <input id="quick" type="search" autocomplete="off" spellcheck="false" placeholder="trace id, order id, reason code…">
      <button type="button" id="reset" class="btn-quiet">Clear filters</button>
      <span class="count" id="count" aria-live="polite"></span>
    </div>
  </div>
  <div class="grid" id="grid"></div>
  <aside class="detail" id="detail" aria-live="polite">
    <p class="detail-empty">Select a row to see its hash check.</p>
  </aside>
</section>
${mode === "sample" ? sampleTracesHtml(sampleTraces) : ""}
<noscript><p class="notice">The console needs JavaScript for its grid and charts. Every trace is still readable on its own page under /r/.</p></noscript>
</main>
<script src="${vendorPath(VENDOR.grid)}" defer></script>
<script src="${vendorPath(VENDOR.charts)}" defer></script>
<script src="/assets/chain-verify.js" defer></script>
<script src="/assets/console.js" nonce="${n}" defer></script>
</body>
</html>`;
  return { html, policy: consolePolicy(nonce) };
}

/** Said instead of the console when a server has none to show this visitor. */
export const OPERATOR_CONSOLE_OFF = "The operator console is off on this server, because the public demo is on and the console would show every visitor's purchases. Each demo visitor has their own console at /demo/console. To see the whole ledger, run the server locally with the demo off.";
