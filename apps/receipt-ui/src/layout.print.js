// Puts the page's own address in the print footer. Served as a file so the page's
// Content-Security-Policy can forbid inline script.
(function () {
  var footer = document.querySelector(".print-footer");
  if (footer) footer.textContent = window.location.href;
})();
