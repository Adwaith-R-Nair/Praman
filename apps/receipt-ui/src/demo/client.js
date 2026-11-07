// The demo page's only script. It changes nothing about what is sent: every form posts
// to a fixed route with an empty body. It only shows that a step is running, since a
// model call takes a few seconds, and copies the PayPal link.
document.addEventListener("submit", function (event) {
  var form = event.target;
  var button = form.querySelector("button");
  if (!button) return;
  // Disabled after the submit is under way, so the click itself still posts.
  setTimeout(function () {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.textContent = "Working…";
  }, 0);
});

document.querySelectorAll("input.link").forEach(function (input) {
  input.addEventListener("focus", function () {
    input.select();
  });
});
