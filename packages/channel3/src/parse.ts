import { Err, Ok, type Result } from "@praman/shared";

/**
 * One offer for a product, as Channel3 described it. `price_text` is the price
 * exactly as it was written in the response body, never a JavaScript number:
 * Channel3 sends prices as JSON numbers in dollars and cents (22.99), and
 * reading one into a float is where a cent goes missing.
 */
export interface Channel3Offer {
  readonly url: string;
  readonly domain: string;
  readonly price_text: string;
  readonly currency: string;
  readonly availability: string;
}

/** A product from Channel3's search. Every string here is Channel3's or a retailer's text: untrusted. */
export interface Channel3Product {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly brand: string | null;
  /** Category slugs from the top of Channel3's taxonomy down, e.g. ["home-garden", "kitchen-dining", ...]. */
  readonly category_path: readonly string[];
  readonly offers: readonly Channel3Offer[];
}

const PRICE_KEYS = new Set(["price", "compare_at_price"]);

/** A decimal number's source text, kept apart from strings so a quoted "22.99" can't pass for one. */
class DecimalText {
  constructor(readonly text: string) {}
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * JSON.parse with the source text of every price number kept, through the
 * reviver's third argument (Node 21 and later). A runtime that doesn't pass it
 * gets a refusal, not a float.
 */
function parseKeepingPrices(raw: string): unknown {
  return JSON.parse(raw, function (key: string, value: unknown, context?: { readonly source?: string }): unknown {
    if (typeof value !== "number" || !PRICE_KEYS.has(key)) return value;
    if (context?.source === undefined) throw new Error("this runtime does not expose JSON number source text");
    return new DecimalText(context.source);
  });
}

function parseOffer(o: unknown): Channel3Offer | null {
  if (!isRecord(o)) return null;
  const price = o["price"];
  if (!isRecord(price)) return null;
  const amount = price["price"];
  const url = str(o["url"]);
  const domain = str(o["domain"]);
  const currency = str(price["currency"]);
  const availability = str(o["availability"]);
  if (!(amount instanceof DecimalText) || url === null || domain === null || currency === null || availability === null) return null;
  return { url, domain, price_text: amount.text, currency, availability };
}

function parseProduct(p: unknown): Channel3Product | null {
  if (!isRecord(p)) return null;
  const id = str(p["id"]);
  const title = str(p["title"]);
  if (id === null || title === null || !Array.isArray(p["offers"])) return null;
  const brands = Array.isArray(p["brands"]) ? p["brands"] : [];
  const firstBrand: unknown = brands[0];
  const category = p["category"];
  const path = isRecord(category) && Array.isArray(category["path"]) ? category["path"] : [];
  return {
    id,
    title,
    description: str(p["description"]),
    brand: isRecord(firstBrand) ? str(firstBrand["name"]) : null,
    category_path: path.flatMap((c: unknown) => (isRecord(c) && typeof c["slug"] === "string" ? [c["slug"]] : [])),
    offers: p["offers"].flatMap((o: unknown) => {
      const offer = parseOffer(o);
      return offer === null ? [] : [offer];
    }),
  };
}

/**
 * Reads the body of `POST /v1/search`. A product missing an id, a title or an
 * offers list is dropped, and so is an offer whose price isn't a JSON number:
 * nothing is guessed. The body itself not being a search response is an error.
 */
export function parseSearchResponse(raw: string): Result<readonly Channel3Product[], string> {
  let parsed: unknown;
  try {
    parsed = parseKeepingPrices(raw);
  } catch (err) {
    return Err(`Channel3 response is not readable JSON: ${err instanceof Error ? err.message : "unknown error"}`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["products"])) return Err("Channel3 response has no products list");
  return Ok(
    parsed["products"].flatMap((p: unknown) => {
      const product = parseProduct(p);
      return product === null ? [] : [product];
    }),
  );
}
