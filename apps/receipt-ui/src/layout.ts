import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CSS = readFileSync(fileURLToPath(new URL("./style.css", import.meta.url)), "utf8");

/** Where the top link of a page leads. A demo step's trace goes back to the demo, since that is where its visitor came from. */
export type NavTarget = "index" | "demo";

const NAV_LINKS: Readonly<Record<NavTarget, string>> = {
  index: `<a href="/">← all traces</a>`,
  demo: `<a href="/demo">← back to the demo</a>`,
};

export function layout(title: string, body: string, nav: NavTarget = "index"): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Praman</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=PT+Serif:ital,wght@0,400;0,700;1,400&family=IBM+Plex+Mono:wght@400;500;600&family=Noto+Serif:ital,wght@0,400;1,400&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
<div class="record">
<nav class="nav">${NAV_LINKS[nav]}</nav>
${body}
<footer class="print-footer"></footer>
</div>
<script>document.querySelector(".print-footer").textContent = window.location.href;</script>
</body>
</html>`;
}
