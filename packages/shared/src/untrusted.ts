const OPEN = "<untrusted_merchant_content>";
const CLOSE = "</untrusted_merchant_content>";

/**
 * Every angle bracket a reader could take as one: ASCII, and the small and
 * full-width forms that NFKC folds to < and >.
 */
const ANGLE_BRACKETS = /[<>﹤﹥＜＞]/g;

function neutralise(bracket: string): string {
  return bracket === "<" || bracket === "﹤" || bracket === "＜" ? "‹" : "›";
}

/**
 * Wraps merchant-origin text before it enters a prompt. See D-07: sanitisation
 * belongs to the consumer, not the producer — the merchant is the untrusted
 * party, so asking it to sanitise itself is asking the attacker to be careful.
 *
 * The neutralising is the whole defence. Without it, a product description
 * containing the closing tag closes the block early and escapes.
 *
 * Every angle bracket in the merchant's text becomes a single angle quotation
 * mark (‹ ›), so the text can't hold a tag of any spelling. Removing the tags
 * instead was unsound: one removal pass rebuilds a nested tag
 * (`</untrusted_merchant_</untrusted_merchant_content>content>`), and a
 * removal pattern has to guess every case, whitespace and lookalike variant.
 * Replacing a character never joins two pieces of text, and with no bracket
 * left there is no variant to guess.
 */
export function wrapUntrusted(text: string): string {
  const neutralised = text.replace(ANGLE_BRACKETS, neutralise);
  return `${OPEN}\n${neutralised}\n${CLOSE}`;
}
