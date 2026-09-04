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

/** Agent-facing view. Carries untrusted text; the consumer must wrap it. */
export async function listCatalogForAgent(tx: PrismaTx, merchantId: string) {
  const rows = await tx.catalogItem.findMany({ where: { merchantId } });
  return rows.map((r) => ({
    sku: r.sku,
    title: r.title,
    description: r.description,
    category: r.category,
    in_stock: r.stockQty > 0,
  }));
}
