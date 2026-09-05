import { paiseFromDb } from "@praman/shared";
import type { PrismaTx } from "./index.js";

export interface CatalogItemRow {
  readonly sku: string;
  readonly category: string;
  readonly price_paise: bigint;
  readonly stock_qty: number;
  readonly title: string;
  readonly description: string; // UNTRUSTED
}

/** Trusted snapshot for policy evaluation. Prices come from here, never the model. */
export async function loadCatalogSnapshot(tx: PrismaTx, merchantId: string) {
  const rows = await tx.catalogItem.findMany({ where: { merchantId } });
  return {
    merchant_id: merchantId,
    items: new Map(
      rows.map((r) => [
        r.sku,
        {
          sku: r.sku,
          category: r.category,
          price_paise: paiseFromDb(r.pricePaise),
          stock_qty: r.stockQty,
        },
      ]),
    ),
  };
}

/**
 * Agent-facing view. Carries `price_paise` — prices are trusted, they come
 * from this database, never from merchant free text, so D-01's guarantee
 * (the intent carries no price; the charged amount is always resolved
 * server-side) holds regardless of whether the model can see one. The agent
 * cannot shop without knowing what things cost. What stays hidden is the
 * mandate's limits (D-08), not the catalog's prices — those are public
 * facts, caps are not. `title`/`description` are merchant-authored and
 * untrusted; the consumer must wrap them (`wrapUntrusted`, D-07).
 */
export async function listCatalogForAgent(tx: PrismaTx, merchantId: string) {
  const rows = await tx.catalogItem.findMany({ where: { merchantId } });
  return rows.map((r) => ({
    sku: r.sku,
    title: r.title,
    description: r.description,
    category: r.category,
    price_paise: paiseFromDb(r.pricePaise),
    in_stock: r.stockQty > 0,
  }));
}

/**
 * The exact available quantity, not just the in_stock boolean listCatalogForAgent
 * exposes — the merchant MCP server's check_stock(sku, qty) tool needs a real
 * number to compare against, not a threshold-at-zero flag.
 */
export async function checkStock(
  tx: PrismaTx,
  merchantId: string,
  sku: string,
): Promise<{ readonly available_qty: number; readonly in_stock: boolean } | null> {
  const row = await tx.catalogItem.findUnique({ where: { merchantId_sku: { merchantId, sku } } });
  if (!row) return null;
  return { available_qty: row.stockQty, in_stock: row.stockQty > 0 };
}
