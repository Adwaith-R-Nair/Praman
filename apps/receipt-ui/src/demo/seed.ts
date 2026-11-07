import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { prisma } from "@praman/db";
import { CAFE, CAFE_ITEMS, DEMO_CURRENCY, HARNESS, HARNESS_ITEMS, INJECTION_FIXTURE, MARKET, MARKET_PRICES, type DemoItem } from "./config.js";

const FIXTURE_PATH = fileURLToPath(new URL(`../../../eval/fixtures/catalogs/${INJECTION_FIXTURE}.json`, import.meta.url));

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The market's listing, taken from the static corpus fixture: its SKUs, titles,
 * descriptions and categories as written there, poisoned line included. Only the
 * prices are this demo's own, in USD. Nothing here writes or varies attack text
 * (invariant 9).
 */
export function marketItems(raw: string = readFileSync(FIXTURE_PATH, "utf8")): DemoItem[] {
  const parsed: unknown = JSON.parse(raw);
  const items = isRecord(parsed) ? parsed["items"] : null;
  if (!Array.isArray(items)) throw new Error(`fixture ${INJECTION_FIXTURE} has no items`);
  return items.map((item: unknown) => {
    if (!isRecord(item)) throw new Error(`fixture ${INJECTION_FIXTURE} has a malformed item`);
    const { sku, title, description, category } = item;
    if (typeof sku !== "string" || typeof title !== "string" || typeof description !== "string") throw new Error(`fixture ${INJECTION_FIXTURE} has a malformed item`);
    if (category !== "food" && category !== "beverage" && category !== "giftcard") throw new Error(`fixture ${INJECTION_FIXTURE} item ${sku} has an unknown category`);
    const priceMinor = MARKET_PRICES[sku];
    if (priceMinor === undefined) throw new Error(`no demo price for fixture SKU ${sku}`);
    return { sku, title, description, category, priceMinor, stockQty: 500 };
  });
}

/**
 * Writes the three demo merchants and their catalogs. The rail of each is set here,
 * on the server, and nothing a visitor sends can change it (D-32). Safe to run on
 * every start: it replaces only these merchants' rows.
 */
export async function seedDemoCatalog(db: typeof prisma = prisma): Promise<void> {
  const merchants: readonly { id: string; rail: "paypal" | "simulated"; items: readonly DemoItem[] }[] = [
    { id: CAFE, rail: "paypal", items: CAFE_ITEMS },
    { id: MARKET, rail: "simulated", items: marketItems() },
    { id: HARNESS, rail: "simulated", items: HARNESS_ITEMS },
  ];
  for (const m of merchants) {
    await db.$transaction([
      db.merchant.upsert({ where: { merchantId: m.id }, create: { merchantId: m.id, rail: m.rail, currency: DEMO_CURRENCY }, update: { rail: m.rail, currency: DEMO_CURRENCY } }),
      db.catalogItem.deleteMany({ where: { merchantId: m.id } }),
      db.catalogItem.createMany({ data: m.items.map((i) => ({ merchantId: m.id, currency: DEMO_CURRENCY, ...i })) }),
    ]);
  }
}
