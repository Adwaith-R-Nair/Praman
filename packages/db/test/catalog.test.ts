import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { listCatalogForAgent, loadCatalogSnapshot, loadMerchantConfig, prisma } from "../src/index.js";

const USD_MERCHANT = "MERCH_TEST_USD";

beforeEach(async () => {
  await prisma.catalogItem.deleteMany({ where: { merchantId: USD_MERCHANT } });
  await prisma.merchant.deleteMany({ where: { merchantId: USD_MERCHANT } });
});

afterAll(async () => {
  await prisma.catalogItem.deleteMany({ where: { merchantId: USD_MERCHANT } });
  await prisma.merchant.deleteMany({ where: { merchantId: USD_MERCHANT } });
  await prisma.$disconnect();
});

const ITEM = { merchantId: USD_MERCHANT, sku: "SKU_1", title: "t", description: "d", category: "food", priceMinor: 1250n, stockQty: 3 };

describe("catalog currency", () => {
  it("carries the item's currency into the policy snapshot", async () => {
    await prisma.catalogItem.create({ data: { ...ITEM, currency: "USD" } });
    const snapshot = await loadCatalogSnapshot(prisma, USD_MERCHANT);
    expect(snapshot.items.get("SKU_1")?.currency).toBe("USD");
  });

  it("carries the item's currency into the agent's view", async () => {
    await prisma.catalogItem.create({ data: { ...ITEM, currency: "USD" } });
    const [item] = await listCatalogForAgent(prisma, USD_MERCHANT);
    expect(item?.currency).toBe("USD");
  });

  it("the database refuses an unsupported currency", async () => {
    await expect(prisma.catalogItem.create({ data: { ...ITEM, currency: "JPY" } })).rejects.toThrow();
  });

  it("the database has no default that could quietly make a new item INR", async () => {
    // Raw SQL because Prisma's types already refuse to compile a missing currency.
    await expect(
      prisma.$executeRaw`INSERT INTO catalog_item (merchant_id, sku, title, description, category, price_minor, stock_qty)
                         VALUES (${USD_MERCHANT}, 'SKU_2', 't', 'd', 'food', 100, 1)`,
    ).rejects.toThrow();
  });
});

describe("loadMerchantConfig", () => {
  it("returns the configured rail and currency", async () => {
    await prisma.merchant.create({ data: { merchantId: USD_MERCHANT, rail: "paypal", currency: "USD" } });
    await expect(loadMerchantConfig(prisma, USD_MERCHANT)).resolves.toEqual({
      merchant_id: USD_MERCHANT,
      rail: "paypal",
      currency: "USD",
    });
  });

  it("returns null for a merchant with no configuration", async () => {
    await expect(loadMerchantConfig(prisma, USD_MERCHANT)).resolves.toBeNull();
  });

  it("the database refuses an unknown rail", async () => {
    await expect(prisma.merchant.create({ data: { merchantId: USD_MERCHANT, rail: "cash", currency: "USD" } })).rejects.toThrow();
  });
});
