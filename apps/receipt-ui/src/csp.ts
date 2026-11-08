/**
 * Sent on every response. Script and style come only from this origin (and Google's
 * font stylesheet), nothing inline, so text that slips past escaping still can't run.
 * Forms may post here, and the demo's POSTs redirect on to PayPal's sandbox, which
 * form-action has to allow. No page may be framed.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self' https://www.sandbox.paypal.com",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * The console page's policy: the same, except that a <style> element carrying this
 * response's nonce may apply. AG Grid and AG Charts build their styles in the browser
 * and put them in <style> elements, which they mark with the nonce they are given
 * (their styleNonce option). Script stays 'self' only, nothing is 'unsafe-inline', and
 * an inline style attribute is still refused. The nonce is new on every response (D-63).
 */
export function consolePolicy(nonce: string): string {
  if (!/^[A-Za-z0-9+/_-]{16,}={0,2}$/.test(nonce)) throw new TypeError("a style nonce must be at least 16 base64 characters");
  return CONTENT_SECURITY_POLICY.replace("style-src 'self' https://fonts.googleapis.com", `style-src 'self' 'nonce-${nonce}' https://fonts.googleapis.com`);
}
