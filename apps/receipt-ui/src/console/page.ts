import { randomBytes } from "node:crypto";
import { VENDOR, vendorPath } from "../assets.js";
import { consolePolicy } from "../csp.js";
import { escapeHtml } from "../html.js";

/** Who is looking: a demo visitor at their own session, or a local operator at the whole ledger. */
export type ConsoleMode = "visitor" | "operator";

export interface ConsolePage {
  readonly html: string;
  /** The Content-Security-Policy for this response only. Its style nonce is new each time. */
  readonly policy: string;
}

/** A fresh nonce for one console response. 18 random bytes, base64. */
export function newStyleNonce(): string {
  return randomBytes(18).toString("base64");
}

const COPY: Readonly<Record<ConsoleMode, { readonly back: string; readonly backLabel: string; readonly title: string; readonly lede: string; readonly data: string }>> = {
  visitor: {
    back: "/demo",
    backLabel: "← back to the demo",
    title: "Your session on the ledger",
    lede: "Every ledger row this session's two mandates produced: the story's mandate and the separate one the twenty-at-once test spends. Each row's hashes are recomputed on the server, and the whole chain is walked from its first row. Nobody else's rows are here, and yours are not in anyone else's console.",
    data: "/demo/console/data",
  },
  operator: {
    back: "/",
    backLabel: "← all traces",
    title: "Operator console",
    lede: "The newest rows of the whole ledger, every mandate and every rail. This view exists only on a server with the demo turned off, which in practice means your own machine.",
    data: "/console/data",
  },
};

/**
 * The console's page. It carries no ledger data: the script fetches it from the data
 * route, as JSON, and every value goes into the page as text. The page itself is a
 * fixed frame, so the only thing that changes per response is the style nonce.
 */
export function renderConsolePage(mode: ConsoleMode, nonce: string, notice: string | null = null): ConsolePage {
  const copy = COPY[mode];
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
</head>
<body>
<main class="console" id="console" data-mode="${escapeHtml(mode)}" data-src="${escapeHtml(copy.data)}">
<nav class="nav"><a href="${escapeHtml(copy.back)}">${escapeHtml(copy.backLabel)}</a></nav>
<header class="masthead">
  <p class="kicker">Ledger console</p>
  <h1>${escapeHtml(copy.title)}</h1>
  <p class="lede">${escapeHtml(copy.lede)}</p>
</header>
${notice === null ? "" : `<p class="notice" role="status">${escapeHtml(notice)}</p>`}
<section class="chain" id="chain" role="status" aria-live="polite" data-state="loading">
  <span class="chain-stamp" id="chain-stamp">Checking</span>
  <p class="chain-text" id="chain-text">Walking the hash chain from its first row.</p>
</section>
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
      <p class="card-note">Every decision and capture re-check. Select a bar to filter the ledger below to that code.</p>
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
<noscript><p class="notice">The console needs JavaScript for its grid and charts. Every trace is still readable on its own page under /r/.</p></noscript>
</main>
<script src="${vendorPath(VENDOR.grid)}" defer></script>
<script src="${vendorPath(VENDOR.charts)}" defer></script>
<script src="/assets/console.js" nonce="${n}" defer></script>
</body>
</html>`;
  return { html, policy: consolePolicy(nonce) };
}

/** Said instead of the console when a server has none to show this visitor. */
export const OPERATOR_CONSOLE_OFF = "The operator console is off on this server, because the public demo is on and the console would show every visitor's purchases. Each demo visitor has their own console at /demo/console. To see the whole ledger, run the server locally with the demo off.";
