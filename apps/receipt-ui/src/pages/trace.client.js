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
