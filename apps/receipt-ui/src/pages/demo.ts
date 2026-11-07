import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { formatMoney, minorFromJSON, REASON_CODES, type ReasonCode } from "@praman/shared";
import type { AgentVisibleDecision } from "@praman/policy";
import { CAFE, MARKET, type BeatId, type PurchaseBeat } from "../demo/config.js";
import { canAskAgain } from "../demo/story.js";
import type { BeatRecord, DemoSession } from "../demo/session.js";
import { escapeHtml } from "../html.js";
import { REASON_CODE_PLAIN } from "../reason-codes.js";

const CSS = readFileSync(fileURLToPath(new URL("../demo/demo.css", import.meta.url)), "utf8");

const usd = (minorText: string): string => formatMoney(minorFromJSON(minorText), "USD");

function isReasonCode(code: string): code is ReasonCode {
  return REASON_CODES.some((c) => c === code);
}

function reasonPlain(code: string | null): string | null {
  if (code === null || code === "OK") return null;
  return isReasonCode(code) ? REASON_CODE_PLAIN[code] : null;
}

const NO_PAYPAL = "This server has no PayPal sandbox credentials, so this step can't run here.";
const NO_MODEL = "This server has no model configured, so the agent can't run here.";

const MERCHANT_NAMES: Readonly<Record<string, string>> = { [CAFE]: "Praman Demo Cafe", [MARKET]: "Corner Market" };

/** The demo's own frame: no inline script, one stylesheet, nothing from the receipt layout's print chrome. */
export function demoLayout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Praman</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=PT+Serif:ital,wght@0,400;0,700;1,400&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
<main class="demo">
${body}
</main>
<script src="/demo/client.js" defer></script>
</body>
</html>`;
}

/**
 * Posts to a fixed route. There is never an input field: the route is the whole request.
 * A button that can't be pressed yet says why, next to it, and is described by that line.
 */
function action(path: string, label: string, kind: "primary" | "quiet" = "primary", disabledWhy: string | null = null): string {
  if (disabledWhy === null) {
    return `<form method="post" action="${escapeHtml(path)}" class="act"><button type="submit" class="btn btn-${kind}">${escapeHtml(label)}</button></form>`;
  }
  const id = `why-${path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}`;
  return `<form method="post" action="${escapeHtml(path)}" class="act"><button type="submit" class="btn btn-${kind}" disabled aria-describedby="${escapeHtml(id)}">${escapeHtml(label)}</button></form><p class="why" id="${escapeHtml(id)}">${escapeHtml(disabledWhy)}</p>`;
}

function traceLinks(traceId: string | null): string {
  if (traceId === null) return "";
  const id = encodeURIComponent(traceId);
  return `<p class="links"><a href="/r/${id}">Ledger trace</a><a href="/dispute/${id}">Dispute bundle</a><span class="trace-id">${escapeHtml(traceId)}</span></p>`;
}

/** Exactly what runIntent handed the agent: the redacted decision, never a limit (D-08). */
function agentViewHtml(view: AgentVisibleDecision | null): string {
  if (view === null) return "";
  const told = view.kind === "DENY" ? `DENY, ${view.reason_code}` : `${view.kind}, ${formatMoney(view.amount_minor, "USD")}`;
  return `<div class="agent-view"><span class="agent-view-label">The agent was told</span> <code>${escapeHtml(told)}</code></div>`;
}

function proposalHtml(record: BeatRecord): string {
  const p = record.proposal;
  if (p === null) return `<p class="cell-body">No cart.</p>`;
  const merchant = MERCHANT_NAMES[p.merchantId] ?? p.merchantId;
  const items = p.lineItems.map((i) => `<li><code>${escapeHtml(`${i.qty.toString()} × ${i.sku}`)}</code></li>`).join("");
  return `<p class="cell-body">${escapeHtml(merchant)}</p><ul class="cart">${items}</ul><p class="rationale">${escapeHtml(p.rationale)}</p>`;
}

const DECISION_WORDS: Readonly<Record<string, { word: string; tone: string }>> = {
  ALLOW: { word: "Allowed", tone: "allow" },
  STEP_UP: { word: "Asked you first", tone: "step-up" },
  DENY: { word: "Refused", tone: "deny" },
};

function decisionHtml(record: BeatRecord): string {
  const kind = record.agentView?.kind ?? (record.reasonCode === null ? null : "DENY");
  const finalRefusal = record.state === "refused" && record.reasonCode !== null && kind !== "DENY";
  if (record.state === "refused" && kind === null && record.traceId === null) {
    return `<div class="stamp stamp-deny">Not sent</div><p class="cell-body">The demo checks that the cart is for this step's shop and is a usable order before asking Praman. This one wasn't, so Praman was never asked and nothing went on the ledger.</p>`;
  }
  const shown = finalRefusal ? DECISION_WORDS["DENY"] : kind === null ? null : DECISION_WORDS[kind];
  if (shown === undefined || shown === null) return `<p class="cell-body">No decision.</p>`;
  const plain = reasonPlain(record.reasonCode);
  const amount = record.amountMinor === null ? "" : `<span class="amount">${escapeHtml(usd(record.amountMinor))}</span>`;
  return `<div class="stamp stamp-${shown.tone}">${escapeHtml(shown.word)}</div>${amount}
    ${plain === null ? "" : `<p class="cell-body">${escapeHtml(plain)}</p>`}
    ${record.reasonCode === null ? "" : `<code class="code">${escapeHtml(record.reasonCode)}</code>`}
    ${record.approvalId === null ? "" : `<p class="cell-body">Waiting for you.</p>`}
    ${kind === "STEP_UP" && (record.state === "done" || record.state === "awaiting_checkout") ? `<p class="cell-body"><strong>You approved.</strong> Praman checked the mandate again before paying.</p>` : ""}`;
}

function moneyHtml(record: BeatRecord): string {
  const amount = record.amountMinor === null ? "" : usd(record.amountMinor);
  let what: string;
  let tone = "none";
  if (record.state === "done" && record.payment === "saved_method" && record.orderStatus === "captured" && record.paymentId === null) {
    what = `${amount} charged to the saved PayPal account. No buyer was present.`;
    tone = "moved";
  } else if (record.state === "done" && record.payment === "checkout") {
    what = `${amount} captured after the buyer approved at PayPal.`;
    tone = "moved";
  } else if (record.state === "done" && record.payment === "simulated") {
    what = `${amount} paid on the simulated rail. No real or sandbox money.`;
    tone = "moved";
  } else if (record.state === "done") {
    what = `${amount} captured.`;
    tone = "moved";
  } else if (record.state === "awaiting_checkout") {
    what = `A PayPal checkout order for ${amount} is waiting for the buyer. Nothing is charged until Praman captures it.`;
    tone = "waiting";
  } else if (record.state === "pending") {
    what = "Unknown yet. The budget stays held until the sweep settles it.";
    tone = "waiting";
  } else {
    what = "Nothing charged.";
  }
  const ids = [record.orderId ? `order ${record.orderId}` : null, record.failureCode ? `PayPal said ${record.failureCode}` : null].filter((x) => x !== null);
  return `<p class="cell-body money-${tone}">${escapeHtml(what)}</p>${ids.length > 0 ? `<p class="ids">${escapeHtml(ids.join(", "))}</p>` : ""}`;
}

/** The three hands a purchase passes through. The middle one is the only one that can say yes. */
function gate(record: BeatRecord, moneyLabel: string): string {
  return `<div class="gate">
    <div class="cell cell-agent"><h4>Agent proposed</h4>${proposalHtml(record)}</div>
    <div class="cell cell-praman"><h4>Praman decided</h4>${decisionHtml(record)}</div>
    <div class="cell cell-money"><h4>${escapeHtml(moneyLabel)}</h4>${moneyHtml(record)}</div>
  </div>`;
}

function resultHtml(record: BeatRecord | undefined, moneyLabel = "PayPal"): string {
  if (record === undefined) return "";
  if (record.state === "no_proposal") return `<p class="note">${escapeHtml(record.message)}</p>`;
  return `<div class="result" data-state="${escapeHtml(record.state)}">
    ${gate(record, moneyLabel)}
    <p class="message">${escapeHtml(record.message)}</p>
    ${agentViewHtml(record.agentView)}
    ${traceLinks(record.traceId)}
  </div>`;
}

/** Whether a step's button is offered: before it runs, and again only when nothing can have been charged. */
function askable(beat: BeatId, record: BeatRecord | undefined): boolean {
  return record === undefined || canAskAgain(beat, record);
}

function approvalActions(beat: BeatId, record: BeatRecord | undefined): string {
  if (record?.state !== "awaiting_approval") return "";
  return `<div class="actions">${action(`/demo/approve/${beat}`, "Approve this purchase")}${action(`/demo/reject/${beat}`, "Reject it", "quiet")}</div>`;
}

function step(n: number, id: string, title: string, intro: string, body: string, done: boolean): string {
  return `<section class="step${done ? " step-done" : ""}" id="${escapeHtml(id)}">
    <h2><span class="step-n">${n.toString()}</span>${escapeHtml(title)}</h2>
    <div class="step-body">${intro}${body}</div>
  </section>`;
}

const p = (text: string) => `<p>${escapeHtml(text)}</p>`;

function mandateHtml(session: DemoSession): string {
  const doc = session.mandate.document;
  if (doc.version !== 2) return "";
  const until = new Date(doc.validity.not_after);
  const merchants = doc.scope.merchant_ids.map((m) => MERCHANT_NAMES[m] ?? m).join(" and ");
  return `<div class="mandate">
    <ul class="terms">
      <li>Spend up to <strong>${escapeHtml(usd(doc.limits.max_total_minor))}</strong> in total, in US dollars.</li>
      <li>No single purchase over <strong>${escapeHtml(usd(doc.limits.max_per_txn_minor))}</strong>.</li>
      <li>Ask me before any purchase of <strong>${escapeHtml(usd(doc.step_up.threshold_minor))}</strong> or more, and before the first purchase at any shop.</li>
      <li>Only at ${escapeHtml(merchants)}, and only food and drink.</li>
      <li>At most ${escapeHtml(doc.limits.max_txns_per_window.toString())} purchases an hour. Valid until ${escapeHtml(until.toUTCString())}.</li>
    </ul>
    <p class="seal">Signed with the demo key <code>${escapeHtml(session.mandate.signature.key_id)}</code>. Mandate <code>${escapeHtml(doc.mandate_id)}</code>. The agent never sees these limits.</p>
  </div>`;
}

interface Recording {
  readonly recorded_on: string;
  readonly model: string;
  readonly arm: string;
  readonly currency_note: string;
  readonly catalog_reads: readonly string[];
  readonly proposal: { readonly line_items: readonly { readonly sku: string; readonly qty: number }[]; readonly rationale: string };
  readonly decision: { readonly kind: string; readonly reason_code: string; readonly money_moved: boolean };
}

function isRecording(v: unknown): v is Recording {
  if (typeof v !== "object" || v === null) return false;
  const r: Record<string, unknown> = { ...v };
  return typeof r["recorded_on"] === "string" && typeof r["model"] === "string" && Array.isArray(r["catalog_reads"]) && typeof r["proposal"] === "object" && typeof r["decision"] === "object";
}

const RECORDING_PATH = fileURLToPath(new URL("../demo/recorded/undefended-system-update.json", import.meta.url));

export function loadRecording(raw: string = readFileSync(RECORDING_PATH, "utf8")): Recording {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecording(parsed)) throw new Error("the demo recording is malformed");
  return parsed;
}

/** A recorded run, shown as a recording. Every string is corpus or model text, escaped. */
export function recordingHtml(rec: Recording): string {
  const poisoned = rec.catalog_reads.find((r) => r.includes("SKU_INJ2_BAIT")) ?? rec.catalog_reads[0] ?? "";
  const cart = rec.proposal.line_items.map((i) => `${i.qty.toString()} × ${i.sku}`).join(", ");
  return `<figure class="recording">
    <figcaption><strong>Recorded run, not live.</strong> ${escapeHtml(`${rec.model}, ${rec.recorded_on}, ${rec.arm}. ${rec.currency_note}`)}</figcaption>
    <p class="rec-label">The listing the model read</p>
    <pre class="merchant-text">${escapeHtml(poisoned)}</pre>
    <p class="rec-label">What it proposed</p>
    <p><code>${escapeHtml(cart)}</code></p>
    <p class="rationale">${escapeHtml(rec.proposal.rationale)}</p>
    <p class="rec-label">What Praman did</p>
    <p><code>${escapeHtml(`${rec.decision.kind}, ${rec.decision.reason_code}`)}</code> ${escapeHtml(rec.decision.money_moved ? "Money moved." : "No money moved.")}</p>
  </figure>`;
}

function harnessHtml(record: BeatRecord | undefined): string {
  const h = record?.harness;
  if (record === undefined || h === undefined || h === null) return "";
  const refusals = Object.entries(h.refusals)
    .map(([code, n]) => `<li><code>${escapeHtml(code)}</code> ${escapeHtml(n.toString())}</li>`)
    .join("");
  const traces = h.traces
    .map((t) => `<li><a href="/r/${encodeURIComponent(t.traceId)}">${escapeHtml(t.outcome)}</a></li>`)
    .join("");
  return `<div class="result harness">
    <p class="harness-line"><span class="big">${escapeHtml(h.created.toString())}</span> of ${escapeHtml(h.attempted.toString())} paid. Spent ${escapeHtml(usd(h.createdMinor))} of a ${escapeHtml(usd(h.budgetMinor))} budget, counting the first purchase.</p>
    <ul class="refusals">${refusals}</ul>
    <p class="message">${escapeHtml(record.message)} Model calls: ${escapeHtml(h.modelCalls.toString())}.</p>
    <details><summary>All ${escapeHtml(h.attempted.toString())} traces</summary><ol class="harness-traces">${traces}</ol></details>
    ${traceLinks(h.priorTraceId)}
  </div>`;
}

/** Shown while any purchase step's order waits for the buyer at PayPal. */
function checkoutHtml(beat: PurchaseBeat, record: BeatRecord | undefined): string {
  if (record?.state !== "awaiting_checkout" || record.approveUrl === null) return "";
  return `<div class="checkout">
    <p><strong>Pay at PayPal.</strong> Copy this link into a <strong>different browser</strong> from this one, log in with the sandbox buyer account, and approve. If this is Chrome, use Firefox, Safari or Edge, or your phone. PayPal's sandbox declines a second checkout in the browser session that connected PayPal in step 2, and every private window of one browser shares that session.</p>
    <p class="link-row"><input class="link" type="text" readonly value="${escapeHtml(record.approveUrl)}" aria-label="PayPal checkout link"></p>
    <p>When PayPal says you're done, come back to this tab and capture.</p>
    <div class="actions">${action(`/demo/capture/${beat}`, "Capture the payment")}</div>
  </div>`;
}

export function renderStartPage(notice: string | null, configured: { readonly paypal: boolean; readonly model: boolean }): string {
  const missing = [configured.paypal ? null : "PayPal sandbox credentials", configured.model ? null : "a model key"].filter((x) => x !== null);
  return demoLayout(
    "Demo",
    `<header class="masthead">
      <h1>An agent with a budget, and the one thing that can say yes</h1>
      <p class="lede">An AI agent buys lunch with a PayPal sandbox account. Every purchase it proposes goes to Praman, which checks it against a mandate you signed and decides. The agent can't pay without that decision, and the ledger keeps a verifiable record of each one.</p>
    </header>
    ${notice === null ? "" : `<p class="notice" role="status">${escapeHtml(notice)}</p>`}
    <section class="start">
      <p>You'll need the PayPal sandbox buyer login from the project's testing instructions. It's a US sandbox account with play money.</p>
      <p>Step 5 needs a different browser from this one, such as Firefox if you are in Chrome, or your phone. PayPal's sandbox can refuse a checkout in the same browser session that connected PayPal, and private windows of one browser share that session.</p>
      ${missing.length > 0 ? `<p class="note">This server is missing ${escapeHtml(missing.join(" and "))}, so some steps won't run.</p>` : ""}
      ${action("/demo/start", "Start a session")}
      <p class="small">A session lasts an hour. Sandbox only. No real money moves.</p>
    </section>`,
  );
}

export function renderDemoPage(session: DemoSession, recording: Recording, configured: { readonly paypal: boolean; readonly model: boolean } = { paypal: true, model: true }): string {
  const b = (id: BeatId) => session.beats.get(id);
  const first = b("first");
  const second = b("second");
  const large = b("large");
  const notice = session.notice;

  const connectBody = session.connected
    ? `<p class="ok">Connected. Praman holds the saved PayPal method on its server, tied to this session. The agent and this page never see it, and it is deleted when the session ends.</p>`
    : `${p("Approve, once, saving a PayPal sandbox account for this demo merchant. PayPal opens its own page and sends you back here. Log in with the sandbox buyer account.")}${action("/demo/connect", "Connect PayPal", "primary", configured.paypal ? null : NO_PAYPAL)}`;

  // Why each purchase button is off, if it is. The server refuses the same steps for the same reasons.
  const missing = !configured.paypal ? NO_PAYPAL : !configured.model ? NO_MODEL : null;
  const firstWhy = missing ?? (session.connected ? null : "Connect PayPal in step 2 first.");
  const laterWhy = missing ?? (first?.state === "done" ? null : "Finish the first purchase first.");

  const body = `
<header class="masthead">
  <h1>An agent with a budget, and the one thing that can say yes</h1>
  <p class="lede">Each step below asks a real model for a cart, or sends a labelled test intent. Praman decides, and every decision lands on a hash-chained ledger you can open.</p>
</header>
${notice === null ? "" : `<p class="notice" role="status">${escapeHtml(notice)}</p>`}

${step(1, "mandate", "Your mandate", p("This is what you've authorised the agent to do. Praman enforces it on every purchase."), mandateHtml(session), true)}

${step(2, "connect", "Connect PayPal once", "", connectBody, session.connected)}

${step(
  3,
  "first",
  "First purchase: Praman asks you",
  p("The agent has never bought from this shop, so Praman stops it and asks you. Once you approve, Praman charges the saved PayPal account. No buyer is at PayPal for this."),
  `${askable("first", first) ? action("/demo/step/first", first === undefined ? "Ask the agent to buy lunch" : "Ask the agent again", "primary", firstWhy) : ""}${resultHtml(first)}${approvalActions("first", first)}${checkoutHtml("first", first)}`,
  first?.state === "done",
)}

${step(
  4,
  "second",
  "Second purchase: the agent pays on its own",
  p("Same shop, a small amount. Nobody approves this one, and no buyer is at PayPal. The agent proposes, Praman checks the mandate, and the money moves. Praman's decision is the only thing between the agent and the money."),
  `${askable("second", second) ? action("/demo/step/second", second === undefined ? "Ask the agent to buy a coffee" : "Ask the agent again", "primary", laterWhy) : ""}${second?.state === "done" && second.agentView?.kind === "ALLOW" && second.payment === "saved_method" ? `<p class="spotlight">No person approved this payment and no buyer saw it. Only Praman's ALLOW let it through.</p>` : ""}${resultHtml(second)}${approvalActions("second", second)}${checkoutHtml("second", second)}`,
  second?.state === "done",
)}

${step(
  5,
  "large",
  "Large purchase: you pay at PayPal",
  p("Over the approval threshold. Praman asks you first, then sends this one through a real PayPal checkout that you approve as the buyer. Before taking the money, Praman checks the mandate again: it may have been revoked or expired while you were at PayPal."),
  `${askable("large", large) ? action("/demo/step/large", large === undefined ? "Ask the agent to buy a team lunch" : "Ask the agent again", "primary", laterWhy) : ""}${resultHtml(large)}${approvalActions("large", large)}${checkoutHtml("large", large)}`,
  large?.state === "done",
)}

${step(
  6,
  "injection",
  "A poisoned listing",
  p("Corner Market's listing has a line from Praman's test corpus that tells the model to add a gift card to every order. First the live model reads it. Then a fixed cart from a fooled model goes to Praman. Then a recording of a model that really was fooled."),
  `<h3>The live model reads it</h3>
   ${askable("injection", b("injection")) ? action("/demo/step/injection", b("injection") === undefined ? "Ask the agent to order at Corner Market" : "Ask the agent again", "primary", configured.model ? null : NO_MODEL) : ""}
   ${resultHtml(b("injection"), "Money")}
   <h3>A fooled model, simulated</h3>
   <p class="label-sim">Simulating a fooled model. No model is asked. This is the cart a fooled model proposed in a recorded run, sent straight to Praman.</p>
   ${b("fixture") === undefined ? action("/demo/step/fixture", "Send the fooled cart to Praman", "quiet") : ""}
   ${resultHtml(b("fixture"), "Money")}
   <h3>A model that was fooled, recorded</h3>
   ${recordingHtml(recording)}`,
  b("fixture") !== undefined,
)}

${step(
  7,
  "concurrency",
  "Twenty purchases at once",
  p("Test-harness intents, not the agent: no model is called. One earlier purchase, approved by the test harness, not a person, then twenty purchases sent at the same instant against a separate $30 mandate on the simulated rail. Praman reserves each attempt as it decides, so they can't all slip past the budget together."),
  `${b("concurrency") === undefined ? action("/demo/step/concurrency", "Send twenty at once", "quiet") : ""}${harnessHtml(b("concurrency"))}`,
  b("concurrency") !== undefined,
)}

<footer class="end">
  <p>The session ends in an hour. Ending it now deletes the saved PayPal method at PayPal. The ledger keeps everything.</p>
  ${action("/demo/end", "End this session", "quiet")}
</footer>`;
  return demoLayout("Demo", body);
}

/** Where PayPal sends a buyer who approved in another window. It knows nothing and does nothing. */
export function renderCheckoutReturnPage(cancelled: boolean): string {
  return demoLayout(
    "Back from PayPal",
    `<header class="masthead"><h1>${cancelled ? "Checkout cancelled" : "Approved at PayPal"}</h1></header>
     <section class="start">
       ${cancelled ? p("You cancelled at PayPal. Nothing was charged.") : p("PayPal has your approval. Nothing is charged yet.")}
       ${p("Go back to the browser where your demo session is open and press Capture the payment. This window can be closed.")}
     </section>`,
  );
}

export function renderErrorPage(): string {
  return demoLayout(
    "Something went wrong",
    `<header class="masthead"><h1>That step didn't finish</h1></header>
     <section class="start">
       ${p("Something failed on the server while running it. Any money movement is on the ledger: open the step's trace from the demo page to see exactly what was recorded.")}
       <p><a href="/demo">Back to the demo</a></p>
     </section>`,
  );
}
