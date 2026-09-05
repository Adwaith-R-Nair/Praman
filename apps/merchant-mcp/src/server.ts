import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Same reason as approve.ts/verify-ledger.ts — dotenv must load before any
// dynamic import reaches @praman/db.
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const { prisma, listCatalogForAgent, checkStock } = await import("@praman/db");

const MERCHANT_ID = process.env["MERCHANT_MCP_MERCHANT_ID"] ?? "MERCH_001";

type CatalogItem = Awaited<ReturnType<typeof listCatalogForAgent>>[number];

/** JSON.stringify throws on a bare bigint — price_paise (a Paise brand) needs converting first. */
function toolItem(item: CatalogItem) {
  return {
    sku: item.sku,
    title: item.title,
    description: item.description,
    category: item.category,
    price_paise: item.price_paise.toString(),
    in_stock: item.in_stock,
  };
}

/**
 * D-07: the merchant is the untrusted party in this system, and asking it
 * to sanitise its own output is asking the attacker to grade their own
 * exam. This server returns title/description exactly as stored in the
 * catalog — raw, undelimited, unescaped. wrapUntrusted() stays at the
 * CONSUMING agent's boundary (apps/buyer-agent/src/agent.ts), which is the
 * only place that actually knows this text is about to sit in front of a
 * model. A merchant server that pre-wrapped its own output would be
 * deciding, on the caller's behalf, how the caller must treat data the
 * caller hasn't even received yet — and any other agent connecting to this
 * same server has no particular reason to trust this merchant's own
 * judgment about its own honesty.
 */
const server = new McpServer({ name: "praman-merchant", version: "0.0.0" });

server.registerTool(
  "list_catalog",
  {
    title: "List catalog",
    description: "List every item this merchant sells, optionally filtered by category.",
    inputSchema: { category: z.string().optional() },
  },
  async ({ category }) => {
    const items = await listCatalogForAgent(prisma, MERCHANT_ID);
    const filtered = category ? items.filter((i) => i.category === category) : items;
    return { content: [{ type: "text", text: JSON.stringify(filtered.map(toolItem)) }] };
  },
);

server.registerTool(
  "get_sku",
  {
    title: "Get one item",
    description: "Get one catalog item by SKU.",
    inputSchema: { sku: z.string() },
  },
  async ({ sku }) => {
    const items = await listCatalogForAgent(prisma, MERCHANT_ID);
    const item = items.find((i) => i.sku === sku);
    if (!item) return { content: [{ type: "text", text: `No such SKU: ${sku}` }], isError: true };
    return { content: [{ type: "text", text: JSON.stringify(toolItem(item)) }] };
  },
);

server.registerTool(
  "check_stock",
  {
    title: "Check stock",
    description: "Check whether at least the given quantity of a SKU is available.",
    inputSchema: { sku: z.string(), qty: z.number().int().positive() },
  },
  async ({ sku, qty }) => {
    const stock = await checkStock(prisma, MERCHANT_ID, sku);
    if (!stock) return { content: [{ type: "text", text: `No such SKU: ${sku}` }], isError: true };
    const result = { sku, requested_qty: qty, available_qty: stock.available_qty, sufficient: stock.available_qty >= qty };
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

server.registerTool(
  "get_refund_policy",
  {
    title: "Get refund policy",
    description: "Get this merchant's refund policy.",
  },
  () => ({
    content: [
      {
        type: "text" as const,
        text: "Refunds are accepted within 24 hours of an order being marked delivered, for orders that were not consumed. Contact the merchant directly to initiate a refund.",
      },
    ],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
