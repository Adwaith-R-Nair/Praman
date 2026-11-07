import { fileURLToPath } from "node:url";
import { config } from "dotenv";

// Same reason as approve.ts: dotenv must load before any dynamic import reaches @praman/db.
config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });

const { prisma } = await import("@praman/db");
const { parseSearchResponse, searchChannel3, toSnapshotRows, writeSnapshot } = await import("@praman/channel3");
const { formatMoney } = await import("@praman/shared");
type Channel3Product = import("@praman/channel3").Channel3Product;

/**
 * The USD demo merchant the MCP gateway sells from. Real products from Channel3,
 * paid through the PayPal sandbox. The rail and currency are set here, by the
 * operator, never by Channel3's answer or a model (D-32).
 */
const DEMO_SHOP = "DEMO_SHOP";
const PER_QUERY = 3;

/**
 * A small fixed set, so a run costs six Channel3 credits. Chosen so the gateway's
 * story has something below the step-up threshold, something above it, and
 * something in a category the demo mandate doesn't cover.
 */
const QUERIES = [
  "insulated water bottle",
  "ceramic coffee mug",
  "hardcover dotted notebook",
  "pour over coffee kettle",
  "led desk lamp",
  "noise cancelling headphones",
] as const;

const apiKey = process.env["CHANNEL3_API_KEY"];
if (!apiKey) {
  console.error("✗ CHANNEL3_API_KEY is not set in .env");
  process.exit(1);
}

const fetchedAt = new Date();
const found: Channel3Product[] = [];
for (const query of QUERIES) {
  const raw = await searchChannel3({ apiKey, fetch: globalThis.fetch }, query, PER_QUERY);
  if (!raw.ok) {
    // Nothing is written: a half-fetched snapshot would be a catalog nobody chose.
    console.error(`✗ "${query}": ${raw.error}. The catalog was not changed.`);
    await prisma.$disconnect();
    process.exit(1);
  }
  const parsed = parseSearchResponse(raw.value);
  if (!parsed.ok) {
    console.error(`✗ "${query}": ${parsed.error}. The catalog was not changed.`);
    await prisma.$disconnect();
    process.exit(1);
  }
  console.log(`▸ "${query}": ${parsed.value.length.toString()} product(s)`);
  found.push(...parsed.value);
}

const { rows, skipped } = toSnapshotRows(found, "USD", fetchedAt);
if (rows.length === 0) {
  console.error("✗ no product could be priced exactly in USD. The catalog was not changed.");
  await prisma.$disconnect();
  process.exit(1);
}
await writeSnapshot(DEMO_SHOP, "paypal", "USD", rows);

console.log(`\n✓ ${DEMO_SHOP}: ${rows.length.toString()} item(s), prices pinned at ${fetchedAt.toISOString()}, rail paypal, USD\n`);
for (const r of rows) {
  // Titles are Channel3's text. Fine on an operator's terminal; wrapped before any model sees them.
  console.log(`  ${r.sku.padEnd(12)} ${r.category.padEnd(24)} ${formatMoney(r.price_minor, r.currency).padStart(8)}  ${r.title.slice(0, 60)}`);
}
for (const s of skipped) console.log(`  skipped ${s.id}: ${s.reason}`);

await prisma.$disconnect();
