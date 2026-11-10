import { formatMoney, minorFromJSON, REASON_CODES, type ReasonCode } from "@praman/shared";
import { ERRAND_IDS, ERRANDS, type ErrandId } from "../demo/config.js";
import { canRunErrandAgain, type ShopCatalog } from "../demo/shop.js";
import type { DemoSession, ErrandRecord } from "../demo/session.js";
import { escapeHtml } from "../html.js";
import { REASON_CODE_PLAIN } from "../reason-codes.js";
import { demoLayout } from "./demo.js";
import { toolCallsHtml } from "./tool-calls.js";

const usd = (minorText: string): string => formatMoney(minorFromJSON(minorText), "USD");

function isReasonCode(code: string): code is ReasonCode {
  return REASON_CODES.some((c) => c === code);
}

/** A pinned time as UTC to the minute, which is as exact as the label needs. */
function utc(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function pinnedText(catalog: ShopCatalog): string {
  const from = utc(catalog.pinnedFrom);
  const to = utc(catalog.pinnedTo);
  return from === to ? from : `between ${from} and ${to}`;
}

const NO_MODEL = "This server has no model configured, so the agent can't run here.";

function button(id: ErrandId, label: string, disabledWhy: string | null): string {
  if (disabledWhy === null) return `<form method="post" action="/demo/shop/${id}" class="act"><button type="submit" class="btn btn-primary">${escapeHtml(label)}</button></form>`;
  return `<form method="post" action="/demo/shop/${id}" class="act"><button type="submit" class="btn btn-primary" disabled aria-describedby="why-shop-${id}">${escapeHtml(label)}</button></form><p class="why" id="why-shop-${id}">${escapeHtml(disabledWhy)}</p>`;
}

/** The cart, each line priced from the snapshot. Titles and retailers are the retailer's own text, escaped. */
function cartHtml(record: ErrandRecord, catalog: ShopCatalog): string {
  if (record.lineItems.length === 0) return `<p class="cell-body">No cart.</p>`;
  const lines = record.lineItems
    .map((line) => {
      const item = catalog.items.get(line.sku);
      if (item === undefined) return `<li><code>${escapeHtml(`${line.qty.toString()} × ${line.sku}`)}</code> <span class="shop-muted">not in this shop's catalog</span></li>`;
      const from = item.retailer === null ? "" : `, sold by ${item.retailer}`;
      return `<li><span class="shop-title">${escapeHtml(item.title)}</span> <span class="shop-muted">${escapeHtml(`${item.category}${from}`)}</span> <code>${escapeHtml(`${line.qty.toString()} × ${formatMoney(item.priceMinor, "USD")} catalog price`)}</code></li>`;
    })
    .join("");
  return `<ul class="cart shop-cart">${lines}</ul>`;
}

const STAMPS = {
  DENY: { word: "Refused", tone: "deny" },
  STEP_UP: { word: "Would ask a person first", tone: "step-up" },
  ALLOW: { word: "Allowed", tone: "allow" },
} as const;

function decisionHtml(record: ErrandRecord): string {
  if (record.state === "not_sent") return `<div class="stamp stamp-deny">Not sent</div><p class="cell-body">The cart wasn't a usable order for this shop, so Praman was never asked and nothing went on the ledger.</p>`;
  const view = record.agentView;
  if (view === null) return `<p class="cell-body">No decision shown.</p>`;
  const stamp = STAMPS[view.kind];
  const code = record.reasonCode;
  const plain = code !== null && code !== "OK" && isReasonCode(code) ? REASON_CODE_PLAIN[code] : null;
  const amount = view.kind === "DENY" ? "" : `<span class="amount">${escapeHtml(formatMoney(view.amount_minor, "USD"))}</span>`;
  return `<div class="stamp stamp-${stamp.tone}">${escapeHtml(stamp.word)}</div>${amount}
    ${plain === null ? "" : `<p class="cell-body">${escapeHtml(plain)}</p>`}
    ${code === null ? "" : `<code class="code">${escapeHtml(code)}</code>`}`;
}

function resultHtml(record: ErrandRecord | undefined, catalog: ShopCatalog): string {
  if (record === undefined) return "";
  const calls = toolCallsHtml(record.toolCalls);
  if (record.state === "no_proposal") return `<p class="note">${escapeHtml(record.message)}</p>${calls}`;
  const id = record.traceId === null ? null : encodeURIComponent(record.traceId);
  const links = id === null || record.state === "not_sent" ? "" : `<p class="links"><a href="/r/${id}">Ledger trace</a><a href="/dispute/${id}">Dispute bundle</a><span class="trace-id">${escapeHtml(record.traceId ?? "")}</span></p>`;
  return `<div class="result" data-state="${escapeHtml(record.state)}">
    <div class="gate">
      <div class="cell cell-agent"><h4>Agent proposed</h4>${cartHtml(record, catalog)}</div>
      <div class="cell cell-praman"><h4>Praman decided</h4>${decisionHtml(record)}</div>
      <div class="cell cell-money"><h4>Money</h4><p class="cell-body money-none">Decided, not bought. Nothing was sent to PayPal.</p></div>
    </div>
    <p class="message">${escapeHtml(record.message)}</p>
    ${links}
  </div>
  ${calls}`;
}

function errandHtml(id: ErrandId, record: ErrandRecord | undefined, catalog: ShopCatalog, model: boolean): string {
  const errand = ERRANDS[id];
  const offer = record === undefined || canRunErrandAgain(record);
  const label = record === undefined ? "Send the agent" : "Send the agent again";
  return `<section class="step shop-errand" id="${id}">
    <h2>${escapeHtml(errand.label)}</h2>
    <div class="step-body">
      <p>${escapeHtml(`The goal the model is given: "${errand.goal}"`)}</p>
      ${offer ? button(id, label, model ? null : NO_MODEL) : ""}
      ${resultHtml(record, catalog)}
    </div>
  </section>`;
}

/** The shop's terms, read from the signed document, so the page shows what Praman enforces. */
function termsHtml(session: DemoSession): string {
  const doc = session.shopMandate.document;
  if (doc.version !== 2) return "";
  return `<ul class="terms">
    <li>Shop: <strong>DEMO_SHOP</strong> only, in <strong>${escapeHtml(doc.scope.currency)}</strong></li>
    <li>Categories: <strong>${escapeHtml(doc.scope.categories.join(", "))}</strong></li>
    <li>Up to <strong>${escapeHtml(usd(doc.limits.max_per_txn_minor))}</strong> a purchase and <strong>${escapeHtml(usd(doc.limits.max_total_minor))}</strong> in all</li>
    <li>A person approves anything from <strong>${escapeHtml(usd(doc.step_up.threshold_minor))}</strong>, and the first purchase at a shop</li>
  </ul>`;
}

/**
 * The shop page (D-93). A visitor picks one of the fixed errands; there is no text
 * field. Everything that came from the merchant or the model is escaped, and nothing
 * is loaded from outside the site.
 */
export function renderShopPage(session: DemoSession, catalog: ShopCatalog, configured: { readonly model: boolean }): string {
  const notice = session.notice;
  const body = `
<header class="masthead">
  <h1>Errands at a shop with real products</h1>
  <p class="lede">Pick an errand. A live model shops real products from Channel3's catalog, under a mandate the demo signed for this session, and Praman decides. The page stops at the decision: nothing is bought and nothing is sent to PayPal.</p>
  <p class="console-link"><a href="/demo">Back to the demo</a> · <a href="/demo/console">Open your ledger console</a></p>
</header>
${notice === null ? "" : `<p class="notice" role="status">${escapeHtml(notice)}</p>`}
<section class="step shop-intro" id="shop-terms">
  <h2>This shop's mandate</h2>
  <div class="step-body">
    ${termsHtml(session)}
    <p class="shop-pinned">${escapeHtml(`Prices were pinned ${pinnedText(catalog)}, when this snapshot was taken from Channel3. Praman decides on these stored prices. Today's price at the retailer may differ. ${catalog.items.size.toString()} products.`)}</p>
    <p>${escapeHtml("Nothing in this shop is ever approved, so it stays a shop this mandate has never paid. An errand in scope therefore comes back as one Praman would ask a person about first. Each decision goes on the ledger like any other.")}</p>
  </div>
</section>
${ERRAND_IDS.map((id) => errandHtml(id, session.errands.get(id), catalog, configured.model)).join("\n")}
<footer class="end"><p>DEMO_SHOP is a sandbox merchant with the MCP gateway's terms. The products and prices are real, and no retailer order is ever placed.</p></footer>`;
  return demoLayout("Shop errands", body);
}

/** With no snapshot in the database, the shop says so and offers nothing. */
export function renderShopOffPage(): string {
  return demoLayout(
    "Shop not set up",
    `<header class="masthead"><h1>The shop is not set up here</h1></header><section class="start"><p>This server's database has no Channel3 snapshot, so there is no shop to send the agent to. Nothing was run. <a href="/demo">Go back to the demo</a>.</p></section>`,
  );
}
