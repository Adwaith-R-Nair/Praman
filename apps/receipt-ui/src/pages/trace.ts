import { formatINR, paiseFromJSON, type ReasonCode } from "@praman/shared";
import type { EventType } from "@praman/ledger";
import { loadTrace } from "../data.js";
import { decisionClass, decisionLabel } from "../decision-display.js";
import { escapeHtml, fixRupeeGlyph } from "../html.js";
import { layout } from "../layout.js";
import { EVENT_TYPE_PLAIN, REASON_CODE_PLAIN } from "../reason-codes.js";

/** Free text (goal, rationale, merchant content) may contain a literal ₹. */
function escFreeText(value: string): string {
  return fixRupeeGlyph(escapeHtml(value));
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

  // One card per item, not one undifferentiated wall of text — the whole
  // point is that a reviewer can actually read each product on its own,
  // so an injected line sitting inside one description is something they
  // can notice, not something buried in a paragraph of six items at once.
  const merchantReadsHtml = trace.merchantReads
    .map(
      (item) => `<div class="merchant-item">
        <div class="merchant-item-header">
          <span class="merchant-item-title">${escFreeText(item.title)}</span>
          <span class="merchant-item-price data">${formatINR(paiseFromJSON(item.pricePaise))}</span>
        </div>
        <div class="merchant-item-sku data">${escapeHtml(item.sku)}</div>
        <div class="untrusted">
          <span class="stamp">merchant data</span>
          <p class="untrusted-note">Treated as data, never as instructions.</p>
          <p class="untrusted-content">${escFreeText(item.description)}</p>
        </div>
      </div>`,
    )
    .join("\n");

  // Truncated to the same fixed prefix length on both sides of the join —
  // that consistency is what makes "same characters, same position" a
  // comparison the eye can actually do. Full value kept in data-full for
  // the print stylesheet (commit 9), where truncation stops being right.
  const hashRow = (label: string, value: string) =>
    `<div class="entry-hash"><span class="hash-label">${label}</span> <span class="hash-value" data-full="${escapeHtml(value)}">${escapeHtml(value.slice(0, 8))}…</span></div>`;

  const entriesHtml = trace.entries
    .map(
      (e, i) => `<li class="entry" data-seq="${e.seq.toString()}">
        ${i > 0 ? hashRow("prev_hash", e.prevHash) : ""}
        <div class="entry-header">
          <span class="entry-type">${escapeHtml(EVENT_TYPE_PLAIN[e.eventType as EventType] ?? e.eventType)}</span>
          <span class="entry-seq">seq ${e.seq.toString()}</span>
        </div>
        ${hashRow("entry_hash", e.entryHash)}
      </li>`,
    )
    .join("\n");

  // JSON.stringify produces a safe JS string literal; the extra replace
  // guards against a trace_id that happened to contain "</script>" (never
  // true for our own trc_ format, but this value still came from a URL).
  const traceIdJs = JSON.stringify(traceId).replace(/</g, "\\u003c");

  const body = `
<section class="hero ${decisionClass(trace.decisionKind)}">
  <div class="hero-top">
    <span id="verify-state" class="state state-unverified">not yet verified this session</span>
    <button id="verify-btn" type="button">Verify this chain</button>
  </div>
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

<script>
(function () {
  var TRACE_ID = ${traceIdJs};
  var btn = document.getElementById("verify-btn");
  var stateEl = document.getElementById("verify-state");
  var entries = Array.prototype.slice.call(document.querySelectorAll(".spine .entry"));
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function finish(data) {
    btn.disabled = false;
    btn.textContent = "Verify this chain";
    if (data.traceVerified) {
      stateEl.textContent = "chain verified through " + data.checked + " entries";
      stateEl.className = "state state-verified";
    } else {
      stateEl.textContent = "chain broken at seq " + data.brokenAtSeq;
      stateEl.className = "state state-broken";
    }
  }

  // breakReasonPlain/breakReason come from our own server's closed
  // BreakReason enum, never from free text, so no HTML-escaping is needed
  // for them here.
  function insertBreakMarker(afterEl, data) {
    var marker = document.createElement("div");
    marker.className = "chain-break";
    marker.innerHTML =
      "Chain verification stopped here, at seq " + data.brokenAtSeq + ". " + data.breakReasonPlain +
      ' <span class="data">' + data.breakReason + "</span>";
    afterEl.parentNode.insertBefore(marker, afterEl.nextSibling);
  }

  // Eased rather than a flat per-step stagger — a constant interval reads
  // as mechanical, and an ease-out (fast start, settling toward the end)
  // reads more like a real check landing than a metronome. Total duration
  // scales with how many entries there are to walk, clamped so a very
  // short chain doesn't feel instant and a very long one doesn't drag.
  function walk(data) {
    var n = entries.length;
    var brokenIndex = -1;
    if (!data.traceVerified && data.brokenAtSeq !== null) {
      for (var k = 0; k < n; k++) {
        if (Number(entries[k].getAttribute("data-seq")) >= data.brokenAtSeq) {
          brokenIndex = k;
          break;
        }
      }
    }
    var stopAt = brokenIndex === -1 ? n : brokenIndex + 1;
    var TOTAL_MS = reduced ? 0 : Math.min(900, Math.max(220, stopAt * 90));

    function easeOutCubic(t) {
      return 1 - Math.pow(1 - t, 3);
    }

    for (var i = 0; i < stopAt; i++) {
      (function (i) {
        var t = stopAt <= 1 ? 1 : i / (stopAt - 1);
        var delay = easeOutCubic(t) * TOTAL_MS;
        setTimeout(function () {
          if (i === brokenIndex) {
            entries[i].classList.add("entry-broken");
            insertBreakMarker(entries[i], data);
            for (var j = i + 1; j < n; j++) {
              entries[j].classList.add("entry-unresolved");
            }
          } else {
            entries[i].classList.add("entry-confirmed");
          }
          if (i === stopAt - 1) finish(data);
        }, delay);
      })(i);
    }
  }

  btn.addEventListener("click", function () {
    btn.disabled = true;
    btn.textContent = "Verifying...";
    entries.forEach(function (el) {
      el.classList.remove("entry-confirmed", "entry-broken", "entry-unresolved");
    });
    document.querySelectorAll(".chain-break").forEach(function (el) {
      el.remove();
    });

    fetch("/verify/" + encodeURIComponent(TRACE_ID))
      .then(function (r) { return r.json(); })
      .then(walk)
      .catch(function () {
        stateEl.textContent = "verification failed to run";
        btn.disabled = false;
        btn.textContent = "Verify this chain";
      });
  });
})();
</script>
`;

  return { status: 200, html: layout(`Trace ${traceId}`, body) };
}
