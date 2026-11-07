// The index page's count-up, served as a file so the page's Content-Security-Policy
// can forbid inline script.
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
