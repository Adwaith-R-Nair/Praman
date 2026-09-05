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
