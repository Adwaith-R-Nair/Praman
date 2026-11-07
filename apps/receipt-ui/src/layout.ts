import { escapeHtml } from "./html.js";

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
<title>${escapeHtml(title)} · Praman</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=PT+Serif:ital,wght@0,400;0,700;1,400&family=IBM+Plex+Mono:wght@400;500;600&family=Noto+Serif:ital,wght@0,400;1,400&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/assets/style.css">
</head>
<body>
<div class="record">
<nav class="nav">${NAV_LINKS[nav]}</nav>
${body}
<footer class="print-footer"></footer>
</div>
<script src="/assets/print.js" defer></script>
</body>
</html>`;
}
