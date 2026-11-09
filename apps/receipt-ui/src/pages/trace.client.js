// The trace page's only script, served as a file so the page's Content-Security-Policy
// can forbid inline script. The trace id comes from the button's data attribute.
(function () {
  var btn = document.getElementById("verify-btn");
  if (!btn) return;
  var TRACE_ID = btn.getAttribute("data-trace-id") || "";
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
  // BreakReason enum. They are set as text all the same, never as HTML.
  function insertBreakMarker(afterEl, data) {
    var marker = document.createElement("div");
    marker.className = "chain-break";
    marker.textContent = "Chain verification stopped here, at seq " + data.brokenAtSeq + ". " + data.breakReasonPlain + " ";
    var code = document.createElement("span");
    code.className = "data";
    code.textContent = data.breakReason;
    marker.appendChild(code);
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

// "Verify in my browser". Nothing here asks the server for anything: there is no fetch
// in this block. The rows come from the page's own data attributes, read once, and the
// hashing is chain-verify.client.js, which uses WebCrypto. The "change one digit" box
// alters a copy of those rows held in this script and nothing else, so the page can show
// where a changed ledger would stop verifying. Every value goes into the page as text.
(function () {
  var box = document.getElementById("browser-verify");
  var lib = window.PramanChainVerify;
  var items = Array.prototype.slice.call(document.querySelectorAll(".spine .entry"));
  // No WebCrypto (an old browser, or a page not served over HTTPS): the panel stays hidden.
  if (!box || !lib || !lib.available() || items.length === 0) return;

  var runBtn = document.getElementById("bv-run");
  var tamperBox = document.getElementById("bv-tamper");
  var resultEl = document.getElementById("bv-result");
  var noteEl = document.getElementById("bv-note");
  var serverBtn = document.getElementById("verify-btn");

  function attr(el, name) {
    var value = el.getAttribute(name);
    return value === null ? "" : value;
  }

  // The rows as the server sent them. Never changed: a tampered run works on a copy.
  var sent = items.map(function (el) {
    var withheld = attr(el, "data-withheld");
    return {
      seq: attr(el, "data-seq"),
      ts: attr(el, "data-ts"),
      actor: attr(el, "data-actor"),
      eventType: attr(el, "data-event-type"),
      payloadHash: attr(el, "data-payload-hash"),
      prevHash: attr(el, "data-prev-hash"),
      entryHash: attr(el, "data-entry-hash"),
      payloadText: el.hasAttribute("data-payload") ? el.getAttribute("data-payload") : null,
      withheld: withheld === "" ? [] : withheld.split(","),
    };
  });

  function plural(n, one, many) {
    return n + " " + (n === 1 ? one : many);
  }

  function all(n) {
    return n === 1 ? "" : "all ";
  }

  function clearMarks() {
    items.forEach(function (el) {
      el.classList.remove("entry-confirmed", "entry-broken", "entry-unresolved");
      var line = el.querySelector(".entry-check");
      if (line) line.remove();
    });
    document.querySelectorAll(".chain-break").forEach(function (el) {
      el.remove();
    });
  }

  function rowLine(result, row) {
    var parts = ["entry hash " + (result.entry === "match" ? "matches" : "does not match")];
    if (result.payload === "match") parts.push("payload rehashed, matches");
    else if (result.payload === "mismatch") parts.push("payload rehashed, does not match");
    else if (result.payload === "withheld") parts.push("payload not rehashed, the public copy withholds " + row.withheld.join(", "));
    else parts.push("payload not rehashed, it is too large for this page and is in the dispute bundle");
    if (result.link === "match") parts.push("links to the row before");
    else if (result.link === "mismatch") parts.push("does not link to the row before");
    else parts.push("link not checked, the row before is not on this page");
    return "In this browser: " + parts.join("; ") + ".";
  }

  function show(outcome, rows, change) {
    clearMarks();
    var stopped = false;
    outcome.rows.forEach(function (result, i) {
      var el = items[i];
      if (stopped) {
        el.classList.add("entry-unresolved");
        return;
      }
      var line = document.createElement("div");
      line.className = "entry-check";
      line.textContent = rowLine(result, rows[i]);
      el.appendChild(line);
      if (result.failed === null) {
        el.classList.add("entry-confirmed");
        return;
      }
      stopped = true;
      el.classList.add("entry-broken");
      var marker = document.createElement("div");
      marker.className = "chain-break";
      marker.textContent = "Your browser's check stopped here, at seq " + result.seq + ". " + lib.BREAK_PLAIN[result.failed] + " ";
      var code = document.createElement("span");
      code.className = "data";
      code.textContent = result.failed;
      marker.appendChild(code);
      el.parentNode.insertBefore(marker, el.nextSibling);
    });

    var c = outcome.counts;
    if (outcome.ok) {
      var text = "Verified in this browser. " + plural(c.entries, "entry hash", "entry hashes") + " recomputed, " + all(c.entries) + "matching.";
      if (c.links > 0) text += " " + plural(c.links, "link", "links") + " to the row before checked, " + all(c.links) + "holding.";
      if (c.payloadsRehashed > 0) text += " " + plural(c.payloadsRehashed, "payload", "payloads") + " rehashed, " + all(c.payloadsRehashed) + "matching.";
      resultEl.textContent = text;
      resultEl.className = "bv-result bv-ok";
      var limits = [];
      if (c.payloadsWithheld > 0) limits.push(plural(c.payloadsWithheld, "payload", "payloads") + " can't be rehashed here: the public copy withholds fields from " + (c.payloadsWithheld === 1 ? "it" : "them") + ", so " + (c.payloadsWithheld === 1 ? "its" : "their") + " payload hash is taken as recorded and only the entry hash over it is checked.");
      if (c.payloadsNotHeld > 0) limits.push(plural(c.payloadsNotHeld, "payload is", "payloads are") + " too large for this page and can be rehashed from the dispute bundle.");
      if (c.linksNotChecked > 0) limits.push(plural(c.linksNotChecked, "link", "links") + " not checked: the ledger is one chain shared by every trace, and the row before is not on this page.");
      limits.push("This checks the rows on this page against their own hashes. It can't see the rest of the ledger. The button at the top asks the server for that.");
      noteEl.textContent = limits.join(" ");
    } else {
      resultEl.textContent = "Breaks at seq " + outcome.brokenAt + ". " + outcome.reasonPlain + " (" + outcome.reason + ")";
      resultEl.className = "bv-result bv-broken";
      noteEl.textContent = change
        ? "You changed one digit in this browser's copy: " + (change.field === "amount_minor" ? "the amount (amount_minor)" : "the time") + " of seq " + change.seq + ", from " + change.before + " to " + change.after + ". No request was sent, and the server's ledger is untouched. Untick the box and the copy is as the server sent it."
        : "Nothing was changed in this browser. The rows this page was sent don't hash to what they record.";
    }
  }

  // Each run has a number, and only the newest may write to the page, so a result never
  // shows for a box that has since been ticked or cleared.
  var runs = 0;

  function run() {
    var mine = (runs += 1);
    var change = tamperBox.checked ? lib.tamperOneDigit(sent) : null;
    var rows = change ? change.rows : sent;
    runBtn.disabled = true;
    lib
      .verifyRows(rows)
      .then(function (outcome) {
        if (mine === runs) show(outcome, rows, change);
      })
      .catch(function () {
        if (mine !== runs) return;
        resultEl.textContent = "The check could not run in this browser.";
        resultEl.className = "bv-result bv-broken";
        noteEl.textContent = "";
      })
      .then(function () {
        if (mine === runs) runBtn.disabled = false;
      });
  }

  runBtn.addEventListener("click", run);
  tamperBox.addEventListener("change", run);
  // The server's own check starts clean, so it never sits beside marks from a changed copy.
  if (serverBtn) {
    serverBtn.addEventListener("click", function () {
      runs += 1;
      runBtn.disabled = false;
      tamperBox.checked = false;
      resultEl.textContent = "";
      resultEl.className = "bv-result";
      noteEl.textContent = "";
      items.forEach(function (el) {
        var line = el.querySelector(".entry-check");
        if (line) line.remove();
      });
    });
  }

  box.hidden = false;
})();
