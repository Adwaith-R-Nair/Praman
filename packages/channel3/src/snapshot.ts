import { prisma } from "@praman/db";
import { Err, Ok, minor, type Currency, type Minor, type Result } from "@praman/shared";
import type { Channel3Offer, Channel3Product } from "./parse.js";

export const CHANNEL3_SOURCE = "channel3";

/** Untrusted text is stored as it came, only cut to a size a catalog row should hold. */
export const MAX_TITLE_CHARS = 200;
export const MAX_DESCRIPTION_CHARS = 1200;

/**
 * Channel3 doesn't say how many are in stock, only whether an offer is. An in-stock
 * snapshot item gets this count so `INSUFFICIENT_STOCK` still means something for a
 * large quantity. It is a stand-in, and the docs say so.
 */
export const SNAPSHOT_STOCK_QTY = 25;

const DECIMAL = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/;

/**
 * A price as written in Channel3's JSON ("22.99", "30.0", "20") to integer cents.
 * String logic only. More than two decimals, an exponent, a sign or anything else
 * is refused rather than rounded, because a rounded price is a different price.
 */
export function decimalToMinor(text: string): Result<Minor, string> {
  const m = DECIMAL.exec(text);
  if (m === null || m[1] === undefined) return Err("price is not a plain decimal with at most two places");
  const cents = (m[2] ?? "").padEnd(2, "0");
  return Ok(minor(BigInt(m[1]) * 100n + BigInt(cents)));
}

export interface SnapshotRow {
  readonly sku: string;
  readonly title: string;
  readonly description: string;
  readonly category: string;
  readonly price_minor: Minor;
  readonly currency: Currency;
  readonly stock_qty: number;
  readonly source_ref: string;
  readonly source_url: string;
  readonly fetched_at: Date;
}

export interface Skipped {
  readonly id: string;
  readonly reason: string;
}

/** `C3_` and Channel3's id. Only characters a SKU can safely carry. */
export function skuFor(productId: string): string | null {
  return /^[A-Za-z0-9_-]{1,64}$/.test(productId) ? `C3_${productId}` : null;
}

/**
 * The second level of Channel3's taxonomy ("kitchen-dining", "office-supplies",
 * "audio"), which is specific enough for a mandate to name and broad enough to
 * group things. A product with only a top level uses that.
 */
export function categoryFor(path: readonly string[]): string | null {
  return path[1] ?? path[0] ?? null;
}

/** The cheapest in-stock offer in the snapshot's currency, by exact integer comparison. */
function bestOffer(offers: readonly Channel3Offer[], currency: Currency): { offer: Channel3Offer; price: Minor } | null {
  let best: { offer: Channel3Offer; price: Minor } | null = null;
  for (const offer of offers) {
    if (offer.currency !== currency || offer.availability !== "InStock") continue;
    const price = decimalToMinor(offer.price_text);
    if (!price.ok || price.value === 0n) continue;
    if (best === null || price.value < best.price) best = { offer, price: price.value };
  }
  return best;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Turns Channel3 products into catalog rows with the price pinned now. The title
 * and description stay Channel3's text, untrusted, and are wrapped by whoever puts
 * them in front of a model. A product Praman can't price exactly is skipped, with
 * the reason, never guessed at.
 */
export function toSnapshotRows(
  products: readonly Channel3Product[],
  currency: Currency,
  fetchedAt: Date,
): { readonly rows: readonly SnapshotRow[]; readonly skipped: readonly Skipped[] } {
  const rows: SnapshotRow[] = [];
  const skipped: Skipped[] = [];
  const seen = new Set<string>();
  for (const p of products) {
    const sku = skuFor(p.id);
    if (sku === null) {
      skipped.push({ id: p.id.slice(0, 64), reason: "product id has characters a SKU can't carry" });
      continue;
    }
    if (seen.has(sku)) continue;
    const category = categoryFor(p.category_path);
    if (category === null) {
      skipped.push({ id: p.id, reason: "no category" });
      continue;
    }
    const best = bestOffer(p.offers, currency);
    if (best === null) {
      skipped.push({ id: p.id, reason: `no in-stock ${currency} offer with an exact price` });
      continue;
    }
    seen.add(sku);
    const description = [p.brand !== null ? `Brand: ${p.brand}.` : "", `Sold by ${best.offer.domain}.`, p.description ?? ""].filter((s) => s !== "").join(" ");
    rows.push({
      sku,
      title: clip(p.title, MAX_TITLE_CHARS),
      description: clip(description, MAX_DESCRIPTION_CHARS),
      category,
      price_minor: best.price,
      currency,
      stock_qty: SNAPSHOT_STOCK_QTY,
      source_ref: p.id,
      source_url: best.offer.url,
      fetched_at: fetchedAt,
    });
  }
  return { rows, skipped };
}

/**
 * Replaces one merchant's catalog with a snapshot, and sets the merchant's rail and
 * currency, in one transaction. The rail is server config (D-32), set here by the
 * operator who runs the import, never by anything Channel3 or a model says.
 */
export async function writeSnapshot(
  merchantId: string,
  rail: "paypal" | "simulated",
  currency: Currency,
  rows: readonly SnapshotRow[],
  db: typeof prisma = prisma,
): Promise<void> {
  await db.$transaction([
    db.merchant.upsert({ where: { merchantId }, create: { merchantId, rail, currency }, update: { rail, currency } }),
    db.catalogItem.deleteMany({ where: { merchantId } }),
    db.catalogItem.createMany({
      data: rows.map((r) => ({
        merchantId,
        sku: r.sku,
        title: r.title,
        description: r.description,
        category: r.category,
        priceMinor: r.price_minor,
        currency: r.currency,
        stockQty: r.stock_qty,
        source: CHANNEL3_SOURCE,
        sourceRef: r.source_ref,
        sourceUrl: r.source_url,
        priceFetchedAt: r.fetched_at,
      })),
    }),
  ]);
}
