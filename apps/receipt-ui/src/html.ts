/**
 * Everything rendered on this page can originate from an untrusted source —
 * merchant catalog text, or model-generated rationale that echoes it back.
 * Every interpolated value goes through this first; there is no path that
 * skips it.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * PT Serif (and the Georgia/Times fallbacks) render U+20B9 (₹) as a
 * different-looking glyph on at least one real system tested against —
 * not a missing-glyph case CSS font-fallback would catch, since the slot
 * isn't empty, just wrong. IBM Plex Mono renders it correctly. Rather than
 * chase which serif fonts get this right, force the character itself into
 * a font already confirmed to work — call after escapeHtml(), since ₹
 * needs no escaping itself.
 */
export function fixRupeeGlyph(escapedHtml: string): string {
  return escapedHtml.replace(/₹/g, '<span class="rupee">₹</span>');
}
