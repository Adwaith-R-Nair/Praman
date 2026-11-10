import { prisma } from "@praman/db";

/**
 * A three-product DEMO_SHOP snapshot for the tests and the local browser suite. The titles,
 * categories, retailers and prices are the products in the committed Channel3 test fixture
 * (packages/channel3/test/fixtures/search-response.json), at the cheapest in-stock offer, as
 * `pnpm catalog:channel3` would store them. No network.
 */
export const SHOP_PINNED_AT = new Date("2026-11-08T12:00:00.000Z");

export const SHOP_FIXTURE = [
  { sku: "C3_TnLEXOw", title: "Moka Ceramic Coffee Mug", category: "kitchen-dining", priceMinor: 2000n, sourceUrl: "https://miir.com/products/moka-mug" },
  { sku: "C3_Yy3DRlE", title: "Moleskine Classic Expanded Hardcover Notebook - Dotted, Black, Large", category: "general-office-supplies", priceMinor: 3795n, sourceUrl: "https://www.target.com/p/moleskine" },
  { sku: "C3_4RyHr6R", title: "Noise Cancelling Headphones", category: "audio", priceMinor: 7999n, sourceUrl: "https://www.bestbuy.com/site/headphones" },
] as const;

/** Writes the snapshot, replacing DEMO_SHOP's rows. `extra` adds rows, such as a hostile title. */
export async function seedShopFixture(extra: readonly { sku: string; title: string; description?: string; category: string; priceMinor: bigint }[] = []): Promise<void> {
  const rows = [...SHOP_FIXTURE, ...extra].map((r) => ({
    merchantId: "DEMO_SHOP",
    sku: r.sku,
    title: r.title,
    description: "description" in r && r.description !== undefined ? r.description : `Sold by ${"sourceUrl" in r ? new URL(r.sourceUrl).hostname : "example.com"}.`,
    category: r.category,
    priceMinor: r.priceMinor,
    currency: "USD",
    stockQty: 25,
    source: "channel3",
    sourceRef: r.sku.slice(3),
    sourceUrl: "sourceUrl" in r ? r.sourceUrl : null,
    priceFetchedAt: SHOP_PINNED_AT,
  }));
  await prisma.$transaction([
    prisma.merchant.upsert({ where: { merchantId: "DEMO_SHOP" }, create: { merchantId: "DEMO_SHOP", rail: "paypal", currency: "USD" }, update: { rail: "paypal", currency: "USD" } }),
    prisma.catalogItem.deleteMany({ where: { merchantId: "DEMO_SHOP" } }),
    prisma.catalogItem.createMany({ data: rows }),
  ]);
}

/** No snapshot: the shop's off switch. */
export async function clearShop(): Promise<void> {
  await prisma.catalogItem.deleteMany({ where: { merchantId: "DEMO_SHOP" } });
}
