const OPEN = "<untrusted_merchant_content>";
const CLOSE = "</untrusted_merchant_content>";

/**
 * Wraps merchant-origin text before it enters a prompt. See D-07: sanitisation
 * belongs to the consumer, not the producer — the merchant is the untrusted
 * party, so asking it to sanitise itself is asking the attacker to be careful.
 *
 * The stripping is the whole defence. Without it, a product description
 * containing the closing tag closes the block early and escapes.
 */
export function wrapUntrusted(text: string): string {
  const cleaned = text.split(OPEN).join("").split(CLOSE).join("");
  return `${OPEN}\n${cleaned}\n${CLOSE}`;
}
